'use strict';
(() => {
const NT = window.NostrTools;
const KIND = 25871;
const STUN = 'stun:stun.l.google.com:19302';
const now = () => Math.floor(Date.now() / 1000);
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
function store(k, v) { try { localStorage.setItem(k, v); } catch {} }
function myKey() {
let hex = load('zd-sk');
if (!hex) { hex = NT.utils.bytesToHex(NT.generateSecretKey()); store('zd-sk', hex); }
return NT.utils.hexToBytes(hex);
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
function signal(desk, relays, msg, match, timeoutMs) {
const sk = myKey();
const pk = NT.getPublicKey(sk);
const ck = NT.nip44.v2.utils.getConversationKey(sk, desk);
const pool = new NT.SimplePool();
return new Promise((resolve, reject) => {
let done = false;
let sub = null;
const finish = (err, val) => {
if (done) return;
done = true;
clearTimeout(timer);
try { sub && sub.close(); } catch {}
setTimeout(() => { try { pool.close(relays); } catch {} }, 100);
err ? reject(err) : resolve(val);
};
const timer = setTimeout(() => finish(new Error('데스크탑이 응답하지 않아요 (앱이 켜져 있는지 확인)')), timeoutMs);
sub = pool.subscribe(relays, { kinds: [KIND], authors: [desk], '#p': [pk], since: now() - 10 }, {
maxWait: 4000,
onevent(ev) {
try {
const m = JSON.parse(NT.nip44.v2.decrypt(ev.content, ck));
if (match(m)) finish(null, m);
} catch {}
},
oneose() {
const ev = NT.finalizeEvent({
kind: KIND, created_at: now(), tags: [['p', desk]],
content: NT.nip44.v2.encrypt(JSON.stringify(msg), ck),
}, sk);
Promise.any(pool.publish(relays, ev)).catch(() => finish(new Error('Nostr 릴레이에 연결할 수 없어요')));
},
});
});
}
async function pair(desk, relays, secret) {
const m = await signal(desk, relays, { type: 'pair', secret, name: deviceName() },
(m) => m.type === 'paired' || m.type === 'denied', 20000);
return m.type === 'paired';
}
async function iceServers(desk, relays) {
const key = `zd-ice-${desk}`;
try {
const c = JSON.parse(load(key) || 'null');
if (c && Date.now() < c.until) return c.servers;
} catch {}
let servers = [];
let keep = 10 * 60 * 1000;
try {
const m = await signal(desk, relays, { type: 'ice' }, (m) => m.type === 'ice_servers', 6000);
if (Array.isArray(m.servers)) servers = m.servers;
if (servers.length) keep = 12 * 3600 * 1000;
} catch {}
store(key, JSON.stringify({ until: Date.now() + keep, servers }));
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
function connect(desk, relays) {
const sock = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, onstatus: null };
const status = (s) => { sock.status = s; sock.onstatus && sock.onstatus(s); };
let pc = null;
let dc = null;
let closed = false;
const fin = (reason) => {
if (closed) return;
closed = true;
clearTimeout(lostTimer);
sock.readyState = 3;
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
else watch();
};
(async () => {
status('연결 준비 중… (릴레이 확인)');
const relay = await iceServers(desk, relays);
if (closed) return;
pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }, ...relay] });
dc = pc.createDataChannel('zd', { ordered: true });
dc.binaryType = 'arraybuffer';
dc.onopen = () => { sock.readyState = 1; sock.onopen && sock.onopen(); };
let part = '';
dc.onmessage = (e) => {
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
const nonce = NT.utils.bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
const offer = { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
status(`데스크탑에 접속 요청 보내는 중… (Nostr)\n이 기기: ${mine}`);
const m = await signal(desk, relays, { type: 'offer', sdp: offer, nonce },
(m) => (m.type === 'answer' || m.type === 'denied') && m.nonce === nonce, 25000);
if (m.type === 'denied') { const e = new Error('이 기기는 짝 맺기가 해제됐어요. 데스크탑에서 QR로 다시 연결하세요.'); e.denied = true; throw e; }
theirs = summarize(m.sdp.sdp);
status(`데스크탑 응답 받음, 직접 연결 시도 중…\n이 기기: ${mine}\n데스크탑: ${theirs}`);
await pc.setRemoteDescription(m.sdp);
setTimeout(() => { if (sock.readyState === 0) fin(`20초 안에 연결되지 않았어요 (ICE: ${pc.iceConnectionState} · 이 기기: ${mine} / 데스크탑: ${theirs})`); }, 20000);
})().catch((e) => { sock.lastError = e; fin(e.message); });
return sock;
}
window.ZDP2P = { pair, connect };
})();
