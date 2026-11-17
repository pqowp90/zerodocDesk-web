'use strict';
(() => {
const $ = (s) => document.querySelector(s);
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const HEX = /^[0-9a-f]{64}$/;
const CACHE = 'zd-webui';
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ACCOUNTS = (load('zd-accounts') || 'https://accounts.zerodoc.kr').replace(/\/+$/, '');
const boot = {
hash: '',
desk: null,
installPrompt: null,
sock: null,
pending: [],
take() {
const s = boot.sock;
boot.sock = null;
if (!s || s.readyState !== 1) return null;
s.taken = true;
s.replay = () => { for (const e of boot.pending.splice(0)) s.onmessage && s.onmessage(e); };
return s;
},
forget(pub) {
saveDesks(desks().filter((d) => d.pub !== pub));
try { if (JSON.parse(load('zd-desk') || 'null')?.pub === pub) store('zd-desk', null); } catch {}
},
onWebui: null,
push: true,
openTab: null,
onOpen: null,
};
window.ZDBOOT = boot;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); boot.installPrompt = e; });
if ('serviceWorker' in navigator && isSecureContext) {
navigator.serviceWorker.register('sw.js').catch(() => {});
navigator.serviceWorker.addEventListener('message', (e) => {
const m = e.data;
if (m && m.t === 'zd-open' && typeof m.desk === 'string') openFrom(m.desk, Number.isInteger(m.tab) ? m.tab : null);
});
navigator.serviceWorker.startMessages();
}
function desks() {
let list = [];
try { list = JSON.parse(load('zd-desks') || '[]'); } catch {}
if (!Array.isArray(list)) list = [];
if (!list.length) {
try {
const d = JSON.parse(load('zd-desk') || 'null');
if (d && d.pub) list = [{ pub: d.pub, url: d.url, name: 'DeskDoc' }];
} catch {}
}
return list.filter((d) => d && HEX.test(d.pub) && typeof d.url === 'string');
}
function saveDesks(list) { store('zd-desks', JSON.stringify(list)); }
function useDesk(d) {
saveDesks([d, ...desks().filter((x) => x.pub !== d.pub)]);
store('zd-desk', JSON.stringify({ pub: d.pub, url: d.url }));
try { sessionStorage.setItem('zd-picked', d.pub); } catch {}
}
function screen({ msg, pick = false, paste = false, retry = false, other = false, ask = false }) {
$('#msg').textContent = msg;
$('#pick').hidden = !pick;
$('#acct').hidden = !pick || !$('#acct').childElementCount;
$('#ask').hidden = !ask;
$('#paste').hidden = !paste;
$('#retry').hidden = !retry;
$('#other').hidden = !other;
$('#acts').hidden = !(retry || other);
}
function unpaired(err) {
const help = '데스크탑 앱의 [설정] → [리모트] → "새 기기 연결 QR"을 이 기기로 찍거나, 아래에서 제로독 계정의 PC를 골라 주세요';
if (!standalone) { pick([], err ? `${err}\n\n${help}` : help); return; }
const how = iOS
? 'Safari에서 짝을 맺었다면 Safari의 [설정] → [화면] → "홈 화면 앱으로 연결 옮기기"로 복사한 링크를 붙여넣어 주세요.\n처음이라면 데스크탑 QR을 카메라로 찍어 Safari에서 먼저 짝을 맺거나, 아래에서 제로독 계정의 PC를 골라 주세요.'
: '데스크탑 QR을 카메라로 찍거나, 복사한 연결 링크를 붙여넣거나, 아래에서 제로독 계정의 PC를 골라 주세요.';
pick([], err ? `${err}\n\n${how}` : how, true);
}
let acct;
async function fetchAccount() {
try {
const r = await fetch(`${ACCOUNTS}/api/desks`, { credentials: 'include', cache: 'no-store' });
if (r.status === 401) return (acct = null);
if (!r.ok) return (acct = undefined);
const v = await r.json();
if (!Array.isArray(v.desks) || typeof v.rv !== 'string' || typeof v.token !== 'string') return (acct = undefined);
acct = { ...v, at: Date.now() };
const named = desks().map((d) => {
const a = v.desks.find((x) => x.room === d.pub);
return a ? { ...d, name: a.name } : d;
});
saveDesks(named);
return acct;
} catch {
return (acct = undefined);
}
}
function button(label, sub, onclick) {
const b = Object.assign(document.createElement('button'), { type: 'button' });
b.append(label);
if (sub) b.append(Object.assign(document.createElement('small'), { textContent: sub }));
b.onclick = onclick;
return b;
}
function pick(list, msg, paste = false) {
const box = $('#pick');
const draw = () => {
box.textContent = '';
for (const d of list) box.append(button(d.name, d.pub.slice(0, 8), () => go(d)));
const more = $('#acct');
more.textContent = '';
if (acct) {
for (const a of acct.desks.filter((a) => !list.some((d) => d.pub === a.room))) {
more.append(button(a.name, `${a.app} · 처음 한 번 허용받고 연결`, () => askScreen(a)));
}
more.append(Object.assign(document.createElement('small'), { textContent: `제로독 계정: ${acct.email}` }));
} else if (acct === null) {
more.append(button('제로독 계정으로 내 PC 찾기', '같은 계정으로 로그인한 PC가 목록에 나와요', () => { location.href = `${ACCOUNTS}/desks/login`; }));
}
more.hidden = !more.childElementCount;
};
draw();
screen({ msg: msg || '어느 PC에 연결할까요?', pick: true, paste });
const shown = ++picking;
fetchAccount().then(() => { if (shown === picking && !$('#pick').hidden) draw(); });
}
let picking = 0;
async function freshAccount() {
if (!acct || Date.now() - acct.at > 10 * 60 * 1000) await fetchAccount();
if (!acct) throw new Error('제로독 계정 로그인이 끝났어요. 다시 로그인해 주세요.');
return acct;
}
function askScreen(a) {
const gen = ++attempt;
const ctl = new AbortController();
const show = (msg, code, failed = false) => {
if (gen !== attempt) return;
screen({ msg, ask: true });
$('#code').textContent = code;
$('#ask-again').hidden = !failed;
};
$('#ask-again').onclick = () => askScreen(a);
$('#ask-cancel').onclick = () => { ctl.abort(); attempt++; pick(desks()); };
show(`${a.name}에 연결 요청을 보내는 중…`, '');
(async () => {
let rv;
try {
const proof = await freshAccount();
rv = proof.rv;
await ZDP2P.askPair(a.room, rv, proof.token, (code) => show(`${a.name} 화면이나 이미 연결된 기기에서 허용을 눌러 주세요.\n그 화면에 이 번호가 보이는지 확인하세요.`, code), ctl.signal);
} catch (err) {
show(`${a.name}: ${err.message}`, '', true);
return;
}
if (gen !== attempt) return;
useDesk({ pub: a.room, url: rv, name: a.name });
go(desks()[0]);
})();
}
$('#other').onclick = () => { attempt++; boot.sock?.close(); pick(desks()); };
$('#paste').onsubmit = async (e) => {
e.preventDefault();
let p;
try { p = new URLSearchParams(new URL($('#paste input').value.trim()).hash.slice(1)); } catch { p = new URLSearchParams(); }
const err = await pairWith(p);
if (err) unpaired(err);
else go(desks()[0]);
};
async function pairWith(p) {
const d = p.get('d');
const s = p.get('s');
const k = p.get('k');
const url = p.get('u') || '';
if (!d || !HEX.test(d) || !(s || k) || (k && !HEX.test(k)) || !/^wss?:\/\/./.test(url)) return '링크가 올바르지 않아요';
const name = p.get('n') || desks().find((x) => x.pub === d)?.name || 'DeskDoc';
if (k) {
store('zd-sk', k);
} else {
screen({ msg: `${name}와 짝을 맺는 중…` });
try {
if (!(await ZDP2P.pair(d, url, s))) return 'QR이 만료됐거나 이미 사용됐어요. 데스크탑에서 새 QR을 만들어 주세요.';
} catch (e) {
return e.message;
}
}
useDesk({ pub: d, url, name });
return '';
}
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const text = (b64) => new TextDecoder().decode(bytes(b64));
async function readCache(hash) {
if (!hash) return null;
try {
const r = await (await caches.open(CACHE)).match(`__webui/${hash}`);
return r ? await r.json() : null;
} catch {
return null;
}
}
async function writeCache(hash, files) {
try {
const c = await caches.open(CACHE);
await c.put(`__webui/${hash}`, new Response(JSON.stringify(files), { headers: { 'content-type': 'application/json' } }));
const keep = new Set(desks().map((d) => load(`zd-webui-${d.pub}`)).concat(hash));
for (const r of await c.keys()) if (!keep.has(r.url.split('/__webui/')[1])) await c.delete(r);
} catch {}
}
function receiver(done) {
const parts = {};
return (m) => {
if (m.same) return done(m.hash, null);
if (m.done) {
const files = {};
for (const [p, a] of Object.entries(parts)) files[p] = a.join('');
return done(m.hash, files);
}
(parts[m.path] ||= []).push(m.d);
};
}
async function run(files) {
const doc = new DOMParser().parseFromString(text(files['index.html']), 'text/html');
const type = (p) => (p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
const scripts = [...doc.querySelectorAll('script')].map((s) => { s.remove(); return s.getAttribute('src'); });
const styles = [...doc.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href'));
$('#loader-css')?.remove();
for (const p of styles) if (files[p]) document.head.append(Object.assign(document.createElement('style'), { textContent: text(files[p]) }));
document.body.replaceWith(document.importNode(doc.body, true));
for (const p of scripts) {
if (!p || !files[p]) continue;
await new Promise((res, rej) => {
const s = document.createElement('script');
s.src = URL.createObjectURL(new Blob([bytes(files[p])], { type: type(p) }));
s.async = false;
s.onload = res;
s.onerror = () => rej(new Error(`${p}을(를) 실행하지 못했어요`));
document.body.append(s);
});
}
}
function openFrom(pub, tab) {
const d = desks().find((x) => x.pub === pub);
if (!d) return;
if (boot.desk && boot.desk.pub === pub && boot.onOpen) {
if (tab !== null) boot.onOpen(tab);
return;
}
if (boot.hash) {
const q = new URLSearchParams({ open: pub });
if (tab !== null) q.set('tab', String(tab));
location.replace(`${location.pathname}?${q}`);
return;
}
boot.openTab = tab;
go(d);
}
let attempt = 0;
function go(d, tries = 0) {
const gen = ++attempt;
const others = desks().length > 1;
useDesk(d);
screen({ msg: `${d.name}에 연결하는 중…`, other: others });
const sock = ZDP2P.connect(d.pub, d.url);
boot.sock = sock;
boot.pending = [];
let started = false;
let asked = false;
const receive = receiver(async (hash, got) => {
if (gen !== attempt) return;
const files = got || (await readCache(hash));
if (!files || !files['index.html']) {
if (!got && !asked) { asked = true; sock.send(JSON.stringify({ t: 'webui', have: '' })); return; }
screen({ msg: `${d.name}에서 화면을 받지 못했어요`, retry: true, other: others });
$('#retry').onclick = () => go(d);
sock.close();
return;
}
if (got) {
store(`zd-webui-${d.pub}`, hash);
await writeCache(hash, got);
}
started = true;
boot.hash = hash;
boot.desk = d;
try {
await run(files);
} catch (e) {
store(`zd-webui-${d.pub}`, null);
const again = Object.assign(document.createElement('button'), { type: 'button', textContent: '다시 불러오기' });
again.onclick = () => location.reload();
document.body.replaceChildren(Object.assign(document.createElement('p'), { textContent: `화면을 띄우지 못했어요: ${e.message}` }), again);
}
});
sock.onstatus = (s) => { if (gen === attempt && !started) screen({ msg: `${d.name}에 연결하는 중…\n\n${s}`, other: others }); };
sock.onopen = async () => {
if (gen !== attempt) return;
screen({ msg: `${d.name}: 화면 받는 중…` });
const have = load(`zd-webui-${d.pub}`) || '';
sock.send(JSON.stringify({ t: 'webui', have: (await readCache(have)) ? have : '' }));
};
sock.onmessage = (ev) => {
if (!started && typeof ev.data === 'string') {
let m = null;
try { m = JSON.parse(ev.data); } catch {}
if (m && m.t === 'webui') return receive(m);
if (m && m.t === 'error' && /variant `webui`/.test(m.msg)) {
started = true;
sock.close();
screen({ msg: `${d.name}의 DeskDoc이 너무 오래된 버전이에요.\n데스크탑에서 DeskDoc을 업데이트한 뒤 다시 연결해 주세요.`, retry: true, other: others });
$('#retry').onclick = () => go(d);
return;
}
}
boot.pending.push(ev);
};
sock.onclose = (ev) => {
if (gen !== attempt || started) return;
boot.sock = null;
if (sock.lastError && sock.lastError.denied) {
boot.forget(d.pub);
const msg = `${d.name}: 이 기기는 짝 맺기가 해제됐어요. 데스크탑에서 QR로 다시 연결하세요.`;
const left = desks();
if (left.length) pick(left, msg);
else unpaired(msg);
return;
}
if (tries < 2 && !(sock.lastError && sock.lastError.final)) {
screen({ msg: `${d.name}에 다시 연결하는 중…\n\n${ev.reason || ''}`, other: others });
setTimeout(() => { if (gen === attempt) go(d, tries + 1); }, 1500 * (tries + 1));
return;
}
screen({ msg: `${d.name}에 연결하지 못했어요\n\n${ev.reason || ''}`, retry: true, other: others });
$('#retry').onclick = () => go(d);
};
}
let again = null;
boot.onWebui = (m) => {
again ||= receiver(async (hash, got) => {
again = null;
if (!got || hash === boot.hash || !boot.desk) return;
store(`zd-webui-${boot.desk.pub}`, hash);
await writeCache(hash, got);
location.reload();
});
again(m);
};
(async () => {
const h = new URLSearchParams(location.hash.slice(1));
if (h.get('d')) {
history.replaceState(null, '', location.pathname + location.search);
const err = await pairWith(h);
if (!err) return go(desks()[0]);
const list = desks();
return list.length ? pick(list, err) : unpaired(err);
}
const q = new URLSearchParams(location.search);
if (q.has('pick')) {
history.replaceState(null, '', location.pathname);
try { sessionStorage.removeItem('zd-picked'); } catch {}
const list = desks();
return list.length ? pick(list) : unpaired('');
}
const open = q.get('open');
if (open) {
history.replaceState(null, '', location.pathname);
const d = desks().find((x) => x.pub === open);
const tab = Number(q.get('tab'));
if (d) {
boot.openTab = q.has('tab') && Number.isInteger(tab) ? tab : null;
return go(d);
}
}
const list = desks();
if (!list.length) return unpaired('');
let picked = null;
try { picked = sessionStorage.getItem('zd-picked'); } catch {}
const same = list.find((d) => d.pub === picked) || (list.length === 1 && list[0]);
if (same) return go(same);
pick(list);
})();
})();
