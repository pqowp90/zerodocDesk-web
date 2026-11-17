'use strict';
(() => {
const enc = new TextEncoder();
const dec = new TextDecoder();
const STUN = 'stun:stun.l.google.com:19302';
const HEX64 = /^[0-9a-f]{64}$/;
const OFFLINE = '데스크탑이 꺼져 있거나 인터넷에 연결되어 있지 않아요 (앱이 켜져 있는지 확인)';
const finalError = (msg) => Object.assign(new Error(msg), { final: true });
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
function store(k, v) { try { localStorage.setItem(k, v); } catch {} }
const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));
function b64(u) {
let s = '';
for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
return btoa(s);
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function hkdf(ikm, info) {
const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }, k, 256));
}
const pairKey = (secret, room) => hkdf(enc.encode(secret), `zd-rv1 pair ${room}`);
const deviceKey = (secretHex, room) => hkdf(unhex(secretHex), `zd-rv1 device ${room}`);
async function deviceId(key) {
return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', key)).subarray(0, 16));
}
const aad = (room, dir, id) => enc.encode(`zd-rv1|${room}|${dir}|${id}`);
const aesKey = (key, use) => crypto.subtle.importKey('raw', key, 'AES-GCM', false, [use]);
async function seal(key, room, dir, id, obj, iv) {
iv = iv || crypto.getRandomValues(new Uint8Array(12));
const plain = enc.encode(typeof obj === 'string' ? obj : JSON.stringify(obj));
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(room, dir, id) }, await aesKey(key, 'encrypt'), plain));
const out = new Uint8Array(iv.length + ct.length);
out.set(iv);
out.set(ct, iv.length);
return `${id}.${b64(out)}`;
}
async function open(key, room, dir, wire) {
try {
const dot = wire.indexOf('.');
const id = wire.slice(0, dot);
const raw = unb64(wire.slice(dot + 1));
if (dot < 0 || raw.length < 28) return null;
const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: aad(room, dir, id) }, await aesKey(key, 'decrypt'), raw.subarray(12));
return JSON.parse(dec.decode(pt));
} catch {
return null;
}
}
function deviceSecret() {
let h = load('zd-sk');
if (!HEX64.test(h || '')) {
h = hex(crypto.getRandomValues(new Uint8Array(32)));
store('zd-sk', h);
}
return h;
}
function deviceName() {
const ua = navigator.userAgent;
if (/iPhone/.test(ua)) return 'iPhone';
if (/iPad/.test(ua)) return 'iPad';
if (/Android/.test(ua)) return 'Android';
if (/Windows/.test(ua)) return 'Windows PC';
if (/Mac/.test(ua)) return 'Mac';
return '브라우저';
}
function openRoom(url, room) {
return new Promise((resolve, reject) => {
let ws;
try { ws = new WebSocket(`${url.replace(/\/+$/, '')}/rv/${room}`); } catch { return reject(new Error('만남 서버 주소가 올바르지 않아요')); }
const rv = { ws, cid: '', deskOn: false, key: null, closed: false, hooks: new Set() };
const failed = () => reject(new Error('만남 서버에 연결할 수 없어요 (인터넷 연결을 확인해 주세요)'));
const timer = setTimeout(() => { try { ws.close(); } catch {} failed(); }, 10000);
const dispatch = (m) => { for (const h of [...rv.hooks]) h(m); };
rv.wait = (fn, ms, why) => new Promise((res, rej) => {
const done = (err, v) => { clearTimeout(t); rv.hooks.delete(h); err ? rej(err) : res(v); };
const h = (m) => { try { const v = fn(m); if (v !== undefined) done(null, v); } catch (e) { done(e); } };
const t = setTimeout(() => done(new Error(why)), ms);
rv.hooks.add(h);
if (rv.closed) done(new Error('만남 서버 연결이 끊겼어요'));
});
rv.close = () => { rv.closed = true; try { ws.close(); } catch {} };
ws.onopen = () => ws.send(JSON.stringify({ t: 'phone' }));
ws.onmessage = async (e) => {
let m;
try { m = JSON.parse(e.data); } catch { return; }
if (m.t === 'hello') {
clearTimeout(timer);
rv.cid = m.cid;
rv.deskOn = !!m.desk;
resolve(rv);
} else if (m.t === 'desk') {
rv.deskOn = !!m.on;
dispatch(m);
} else if (m.t === 'down' && m.denied) {
dispatch({ t: 'denied' });
} else if (m.t === 'down' && typeof m.m === 'string' && /^(cpace|ask)\./.test(m.m)) {
const dot = m.m.indexOf('.');
let msg = null;
try { msg = JSON.parse(dec.decode(unb64(m.m.slice(dot + 1)))); } catch {}
if (msg) dispatch({ t: m.m.slice(0, dot), msg });
} else if (m.t === 'down' && typeof m.m === 'string' && rv.key) {
const msg = await open(rv.key, rv.room, 'down', m.m);
if (msg) dispatch({ t: 'sealed', msg });
} else if (m.t === 'err') {
dispatch(m);
}
};
ws.onclose = () => {
clearTimeout(timer);
if (!rv.cid) return failed();
rv.closed = true;
dispatch({ t: 'closed' });
};
ws.onerror = () => {};
rv.room = room;
});
}
async function session(url, room) {
const key = await deviceKey(deviceSecret(), room);
const id = await deviceId(key);
const rv = await openRoom(url, room);
rv.key = key;
rv.id = id;
return rv;
}
async function ask(rv, msg, match, ms, why) {
if (!rv.deskOn) await rv.wait((m) => (m.t === 'desk' && m.on ? true : undefined), 8000, OFFLINE).catch((e) => { throw finalError(e.message); });
rv.ws.send(JSON.stringify({ t: 'up', m: await seal(rv.key, rv.room, 'up', rv.id, msg) }));
return rv.wait((m) => {
if (m.t === 'err' || (m.t === 'desk' && !m.on)) throw finalError(OFFLINE);
if (m.t === 'closed') throw new Error('만남 서버 연결이 끊겼어요');
if (m.t === 'denied') throw finalError('데스크탑이 이 기기를 알아보지 못해요. 데스크탑의 QR로 다시 연결해 주세요.');
if (m.t !== 'sealed') return undefined;
if (m.msg.type === 'denied') {
const e = new Error('이 기기는 짝 맺기가 해제됐어요. 데스크탑에서 QR로 다시 연결하세요.');
e.denied = true;
e.final = true;
throw e;
}
return match(m.msg) ? m.msg : undefined;
}, ms, why);
}
async function pair(room, url, secret) {
const rv = await session(url, room);
try {
if (!rv.deskOn) await rv.wait((m) => (m.t === 'desk' && m.on ? true : undefined), 8000, OFFLINE);
const p = await pairKey(secret, room);
const msg = { type: 'pair', key: hex(rv.key), name: deviceName() };
rv.ws.send(JSON.stringify({ t: 'up', m: await seal(p, room, 'up', 'pair', msg) }));
return await rv.wait((m) => {
if (m.t === 'denied') return false;
if (m.t === 'err' || (m.t === 'desk' && !m.on)) throw new Error(OFFLINE);
if (m.t === 'closed') throw new Error('만남 서버 연결이 끊겼어요');
return m.t === 'sealed' && m.msg.type === 'paired' ? true : undefined;
}, 20000, '데스크탑이 응답하지 않아요 (앱이 켜져 있는지 확인)');
} finally {
rv.close();
}
}
const PIN_WHY = {
pin: 'PIN이 맞지 않아요.',
locked: 'PIN을 여러 번 틀려서 10분 동안 막혔어요. 잠시 뒤 다시 해 주세요.',
no_pin: '이 PC에 PIN이 없어요. PC의 [설정] → [리모트]에서 PIN을 정하거나 QR로 연결해 주세요.',
no_login: '이 PC가 제로독 계정에 로그인되어 있지 않아요.',
account: '이 PC는 지금 로그인한 계정의 PC가 아니에요. 다시 로그인해 주세요.',
unreachable: 'PC가 계정 서버에 닿지 못해요. 잠시 뒤 다시 해 주세요.',
expired: '시간이 지났어요. 다시 해 주세요.',
};
async function pinPair(room, url, pin, token) {
const rv = await session(url, room);
try {
if (!rv.deskOn) await rv.wait((m) => (m.t === 'desk' && m.on ? true : undefined), 8000, OFFLINE);
const sid = hex(crypto.getRandomValues(new Uint8Array(16)));
const run = await ZDCPACE.start(room, sid, await ZDCPACE.pinKey(room, pin));
const reply = (m) => {
if (m.t === 'err' || (m.t === 'desk' && !m.on)) throw new Error(OFFLINE);
if (m.t === 'closed') throw new Error('만남 서버 연결이 끊겼어요');
if (m.t === 'denied') throw new Error('데스크탑이 응답을 거절했어요. 다시 해 주세요.');
if (m.t === 'cpace' && m.msg.sid === sid && m.msg.type === 'cpace_err') throw new Error(PIN_WHY[m.msg.why] || '연결하지 못했어요.');
return undefined;
};
const start = { sid, ya: hex(run.ya), token };
rv.ws.send(JSON.stringify({ t: 'up', m: `cpace.${b64(enc.encode(JSON.stringify(start)))}` }));
const m = await rv.wait((m) => reply(m) ?? (m.t === 'cpace' && m.msg.sid === sid && m.msg.type === 'cpace' ? m.msg : undefined), 20000, '데스크탑이 응답하지 않아요 (앱이 켜져 있는지 확인)');
const isk = /^[0-9a-f]{64}$/.test(m.yb || '') ? await run.finish(unhex(m.yb)) : null;
if (!isk) throw new Error('데스크탑의 답이 올바르지 않아요');
const id = `cp${sid}`;
rv.ws.send(JSON.stringify({ t: 'up', m: await seal(isk, room, 'up', id, { type: 'pin_key', key: hex(rv.key), name: deviceName() }) }));
await rv.wait((m) => reply(m) ?? (m.t === 'sealed' && m.msg.type === 'paired' ? true : undefined), 20000, '데스크탑이 응답하지 않아요 (앱이 켜져 있는지 확인)');
} finally {
rv.close();
}
}
const ASK_WHY = {
denied: '연결을 거절했어요.',
expired: '2분 안에 허용되지 않았어요. 다시 요청해 주세요.',
busy: 'PC에 기다리는 연결 요청이 너무 많아요. 잠시 뒤 다시 해 주세요.',
bad: '요청이 오가는 중에 바뀌었어요. 다시 요청해 주세요.',
no_login: PIN_WHY.no_login,
account: PIN_WHY.account,
unreachable: PIN_WHY.unreachable,
};
async function askPair(room, url, token, onCode, signal) {
const rv = await session(url, room);
const sid = hex(crypto.getRandomValues(new Uint8Array(16)));
const plain = (msg) => JSON.stringify({ t: 'up', m: `ask.${b64(enc.encode(JSON.stringify(msg)))}` });
let asking = false;
const cancel = () => {
if (asking) try { rv.ws.send(plain({ type: 'ask_cancel', sid })); } catch {}
rv.close();
};
if (signal) signal.addEventListener('abort', cancel);
const ping = setInterval(() => { try { rv.ws.send('ping'); } catch {} }, 25000);
try {
if (!rv.deskOn) await rv.wait((m) => (m.t === 'desk' && m.on ? true : undefined), 8000, OFFLINE);
const run = await ZDCPACE.askStart(room, sid);
const reply = (m) => {
if (m.t === 'err' || (m.t === 'desk' && !m.on)) throw new Error(OFFLINE);
if (m.t === 'closed') throw new Error('만남 서버 연결이 끊겼어요');
if (m.t === 'denied') throw new Error('데스크탑이 응답을 거절했어요. 다시 해 주세요.');
if (m.t === 'ask' && m.msg.sid === sid && m.msg.type === 'ask_err') throw new Error(ASK_WHY[m.msg.why] || '연결하지 못했어요.');
return undefined;
};
const step = (type) => (m) => reply(m) ?? (m.t === 'ask' && m.msg.sid === sid && m.msg.type === type ? m.msg : undefined);
const slow = '데스크탑이 응답하지 않아요 (앱이 켜져 있는지 확인)';
rv.ws.send(plain({ type: 'ask', sid, commit: hex(run.commit), token }));
const m = await rv.wait(step('ask'), 20000, slow);
const got = HEX64.test(m.yb || '') ? await run.finish(unhex(m.yb)) : null;
if (!got) throw new Error('데스크탑의 답이 올바르지 않아요');
const box = await seal(got.isk, room, 'up', `ak${sid}`, { type: 'ask_key', key: hex(rv.key), name: deviceName() });
rv.ws.send(plain({ type: 'ask_open', sid, ya: hex(run.ya), box }));
const wait = await rv.wait(step('ask_wait'), 20000, slow);
asking = true;
const ttl = Number(wait.ttl) || 120;
onCode(`${got.code.slice(0, 3)} ${got.code.slice(3)}`, ttl);
await rv.wait((m) => reply(m) ?? (m.t === 'sealed' && m.msg.type === 'paired' ? true : undefined), (ttl + 15) * 1000, ASK_WHY.expired);
asking = false;
} finally {
clearInterval(ping);
if (signal) signal.removeEventListener('abort', cancel);
rv.close();
}
}
async function iceServers(rv, room) {
const key = `zd-ice-${room}`;
try {
const c = JSON.parse(load(key) || 'null');
if (c && Date.now() < c.until && c.servers.length) return c.servers;
} catch {}
let servers = [];
try {
const m = await ask(rv, { type: 'ice' }, (m) => m.type === 'ice_servers', 6000, '릴레이 정보를 받지 못했어요');
if (Array.isArray(m.servers)) servers = m.servers;
} catch (e) {
if (e.final) throw e;
}
if (servers.length) store(key, JSON.stringify({ until: Date.now() + 30 * 60 * 1000, servers }));
return servers;
}
function waitGathering(pc, ms) {
if (pc.iceGatheringState === 'complete') return Promise.resolve();
return new Promise((res) => {
const t = setTimeout(res, ms);
pc.addEventListener('icegatheringstatechange', () => {
if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); }
});
});
}
function summarize(sdp) {
const c = sdp.split('\n').filter((l) => l.startsWith('a=candidate'));
const n = (t) => c.filter((l) => l.includes(`typ ${t}`)).length;
return `host ${n('host')} · srflx ${n('srflx')} · relay ${n('relay')}`;
}
function connect(room, url) {
const sock = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, onstatus: null };
const status = (s) => { sock.status = s; sock.onstatus && sock.onstatus(s); };
let pc = null;
let dc = null;
let rv = null;
let closed = false;
const fin = (reason) => {
if (closed) return;
closed = true;
clearTimeout(lostTimer);
clearTimeout(probeTimer);
sock.readyState = 3;
try { rv && rv.close(); } catch {}
try { pc && pc.close(); } catch {}
sock.onclose && sock.onclose({ reason: reason || '' });
};
sock.send = (s) => { if (dc && dc.readyState === 'open') dc.send(s); };
Object.defineProperty(sock, 'bufferedAmount', { get: () => (dc ? dc.bufferedAmount : 0) });
sock.close = () => fin('closed');
sock.started = Date.now();
const healthy = () => !!pc && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed');
let lostTimer = 0;
const watch = () => {
clearTimeout(lostTimer);
if (sock.readyState !== 1 || healthy()) return;
lostTimer = setTimeout(() => { if (!healthy()) fin('lost'); }, 4000);
};
sock.check = (moved) => {
if (sock.readyState === 0 && moved && Date.now() - sock.started > 1500) fin('lost');
else { watch(); probe(); }
};
let heard = 0;
let probeTimer = 0;
const probe = () => {
if (sock.readyState !== 1 || !dc || dc.readyState !== 'open') return;
clearTimeout(probeTimer);
const before = heard;
sock.send('{"t":"ping"}');
probeTimer = setTimeout(() => { if (heard === before) fin('lost'); }, 3000);
};
(async () => {
status('연결 준비 중… (데스크탑 찾는 중)');
rv = await session(url, room);
if (closed) return rv.close();
status('연결 준비 중… (릴레이 확인)');
const relay = await iceServers(rv, room);
if (closed) return;
pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }, ...relay] });
dc = pc.createDataChannel('zd', { ordered: true });
dc.binaryType = 'arraybuffer';
dc.onopen = () => { sock.readyState = 1; sock.onopen && sock.onopen(); };
let part = '';
dc.onmessage = (e) => {
heard++;
let data = e.data;
if (typeof data === 'string' && data.charCodeAt(0) === 1) {
part += data.slice(2);
if (data[1] !== '1') return;
data = part;
part = '';
}
sock.onmessage && sock.onmessage({ data });
};
dc.onclose = () => fin('channel closed');
let mine = '';
let theirs = '';
pc.oniceconnectionstatechange = () => {
if (sock.readyState === 1) return watch();
status(`직접 연결 시도 중… (ICE: ${pc.iceConnectionState})\n이 기기: ${mine}\n데스크탑: ${theirs}`);
};
pc.onconnectionstatechange = () => {
if (pc.connectionState !== 'failed') return;
if (sock.readyState === 1) return fin('lost');
const hint = relay.length ? '' : '\n\n데스크탑 앱의 설정 › 리모트에서 릴레이(TURN)를 켜면 LTE·5G에서도 연결돼요.';
fin(`연결에 실패했어요 (이 기기: ${mine} / 데스크탑: ${theirs})${hint}`);
};
status('연결 준비 중… (내 주소 수집)');
await pc.setLocalDescription(await pc.createOffer());
await waitGathering(pc, 4000);
mine = summarize(pc.localDescription.sdp);
if (!/a=candidate/.test(pc.localDescription.sdp)) throw new Error('이 기기의 네트워크 주소를 찾지 못했어요 (인터넷 연결을 확인해 주세요)');
const nonce = hex(crypto.getRandomValues(new Uint8Array(8)));
const offer = { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
status(`데스크탑에 접속 요청 보내는 중…\n이 기기: ${mine}`);
const m = await ask(rv, { type: 'offer', sdp: offer, nonce }, (m) => m.type === 'answer' && m.nonce === nonce, 25000, '데스크탑이 응답하지 않아요 (앱이 켜져 있는지 확인)');
rv.close();
theirs = summarize(m.sdp.sdp);
status(`데스크탑 응답 받음, 직접 연결 시도 중…\n이 기기: ${mine}\n데스크탑: ${theirs}`);
await pc.setRemoteDescription(m.sdp);
setTimeout(() => { if (sock.readyState === 0) fin(`20초 안에 연결되지 않았어요 (ICE: ${pc.iceConnectionState} · 이 기기: ${mine} / 데스크탑: ${theirs})`); }, 20000);
})().catch((e) => { sock.lastError = e; fin(e.message); });
return sock;
}
window.ZDP2P = { pair, pinPair, askPair, connect, _seal: { hkdf, pairKey, deviceKey, deviceId, seal, open, hex } };
})();
