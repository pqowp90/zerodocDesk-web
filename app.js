// zerodocDesk web client — the same page runs in the desktop window and on remote devices.
'use strict';

const $ = (s) => document.querySelector(s);
const touch = matchMedia('(pointer: coarse)').matches;

// ---- token: from ?token=… once, then remembered and stripped from the address bar ----
function store(k, v) { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
const qs = new URLSearchParams(location.search);
const token = qs.get('token') || load('zd-token') || '';
if (qs.get('token')) { store('zd-token', qs.get('token')); history.replaceState(null, '', location.pathname); }

// ---- transport mode ----
// The desktop window (and LAN browsers) have a token and talk WebSocket to the local server.
// The hosted page (desk.zerodoc.kr) has none: it reaches the desktop over Nostr + WebRTC.
const isDesktop = ['127.0.0.1', 'localhost'].includes(location.hostname);
const p2pMode = !token || qs.has('p2p');
const hash = new URLSearchParams(location.hash.slice(1));
let desk = null; // { pub, relays } of the paired desktop
try { desk = JSON.parse(load('zd-desk') || 'null'); } catch {}

let toastTimer = 0;
function toast(msg, ms = 4000) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---- state ----
/** @type {Map<number, {id:number, term:any, fit:any, el:HTMLElement, end:bigint, info:any, osTitle:string, unread:boolean}>} */
const sessions = new Map();
let active = null;
let ws = null;
let retry = 500;
let autoCreated = false;
let fontSize = Number(load('zd-font')) || (touch ? 12 : 14);

const theme = {
  background: '#15161a', foreground: '#d8dae0', cursor: '#d97757', selectionBackground: '#3a4050',
  black: '#1e2026', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef',
  magenta: '#c678dd', cyan: '#56b6c2', white: '#d8dae0', brightBlack: '#5c6370',
};

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function input(id, d) { send({ t: 'input', id, d }); }

// ---- clipboard (async API needs a secure context; LAN http falls back to execCommand) ----
async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return; } catch {}
  const ta = Object.assign(document.createElement('textarea'), { value: s });
  document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
}

// ---- terminals ----
function makeSession(info) {
  const el = document.createElement('div');
  el.className = 'term';
  $('#terms').append(el);
  const term = new Terminal({
    fontFamily: "'Cascadia Mono', 'D2Coding', Consolas, 'Malgun Gothic', monospace",
    fontSize, scrollback: 10000, cursorBlink: true, allowProposedApi: true, theme,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);

  const s = { id: info.id, term, fit, el, end: -1n, info, osTitle: '', unread: false };
  term.onData((d) => input(s.id, d));
  term.onResize(({ cols, rows }) => { if (active === s.id) send({ t: 'resize', id: s.id, cols, rows }); });
  term.onTitleChange((t) => { s.osTitle = t; renderTabs(); });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Shift+Enter: newline without sending (Claude Code reads ESC+CR as a newline).
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) { input(s.id, '\x1b\r'); return false; }
    // Ctrl+C copies when something is selected, otherwise it is a normal ^C.
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
      copyText(term.getSelection()); term.clearSelection(); return false;
    }
    // Ctrl+V / Ctrl+Shift+V: leave it to the browser's paste event (xterm turns it into bracketed paste).
    if (e.ctrlKey && e.key.toLowerCase() === 'v') return false;
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') { copyText(term.getSelection()); return false; }
    if (globalShortcut(e)) return false;
    return true;
  });

  // Right click: copy if selected, else paste — like Windows Terminal.
  el.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    if (term.hasSelection()) { copyText(term.getSelection()); term.clearSelection(); return; }
    try { term.paste(await navigator.clipboard.readText()); } catch {}
  });

  sessions.set(info.id, s);
  send({ t: 'attach', id: info.id });
  return s;
}

function dropSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.term.dispose(); s.el.remove(); sessions.delete(id);
  if (active === id) active = null;
}

function activate(id) {
  const s = sessions.get(id);
  if (!s) return;
  active = id;
  s.unread = false;
  for (const o of sessions.values()) o.el.classList.toggle('active', o.id === id);
  requestAnimationFrame(() => {
    s.fit.fit();
    send({ t: 'resize', id, cols: s.term.cols, rows: s.term.rows });
    if (!touch) s.term.focus();
  });
  renderTabs();
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.replaceChildren();
  for (const s of sessions.values()) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (s.id === active ? ' active' : '') + (s.info.alive ? '' : ' dead') + (s.unread ? ' unread' : '');
    const st = Object.assign(document.createElement('span'), { className: 'st' });
    const label = Object.assign(document.createElement('span'), { textContent: (s.osTitle || s.info.title).slice(0, 40) });
    label.title = s.info.cwd;
    const x = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: '탭 닫기' });
    x.onclick = (e) => { e.stopPropagation(); closeTab(s.id); };
    tab.append(st, label, x);
    tab.onclick = () => activate(s.id);
    tab.ondblclick = () => {
      const t = prompt('탭 이름', s.info.title);
      if (t) send({ t: 'rename', id: s.id, title: t });
    };
    tabs.append(tab);
  }
  if (!sessions.size) {
    if (!$('#terms .empty')) $('#terms').append(Object.assign(document.createElement('div'), { className: 'empty', textContent: '+ Claude 로 새 탭을 여세요' }));
  } else {
    $('#terms .empty')?.remove();
  }
}

function closeTab(id) {
  send({ t: 'close', id });
}

/** Asks the server for a new tab; the tab that appears next gets focus. */
function newTab(claude, extra = {}) {
  const ref = active !== null && sessions.get(active);
  // Default folder for "+ Claude": the active tab's folder.
  if (!extra.cwd && ref) extra.cwd = ref.info.cwd;
  wantActivate++;
  send({ t: 'create', claude, cols: ref ? ref.term.cols : 120, rows: ref ? ref.term.rows : 30, ...extra });
}
let wantActivate = 0;

// ---- sidebar: projects and their past Claude conversations ----
let projects = [];
let openProjects = new Set();
try { openProjects = new Set(JSON.parse(load('zd-open') || '[]')); } catch {}
const showAll = new Set();

function ago(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return '방금';
  if (d < 3600) return `${Math.floor(d / 60)}분`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}일`;
  return new Date(sec * 1000).toLocaleDateString();
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderProjects() {
  const box = $('#projects');
  if (!projects.length) { box.replaceChildren(el('div', 'side-empty', 'Claude 대화 기록이 없어요. ＋로 폴더를 추가하세요.')); return; }
  box.replaceChildren(...projects.map((p) => {
    const wrap = el('div', 'proj' + (openProjects.has(p.path) ? ' open' : ''));
    const head = el('div', 'proj-head');
    head.title = p.path;
    const caret = el('span', 'caret', openProjects.has(p.path) ? '▾' : '▸');
    const name = el('span', 'pname', p.name);
    const add = el('button', 'icon new', '＋');
    add.title = `${p.name} 에서 새 대화`;
    add.onclick = (e) => { e.stopPropagation(); newTab(true, { cwd: p.path, title: p.name }); };
    head.append(caret, name, add);
    head.onclick = () => {
      openProjects.has(p.path) ? openProjects.delete(p.path) : openProjects.add(p.path);
      store('zd-open', JSON.stringify([...openProjects]));
      renderProjects();
    };
    const list = el('div', 'proj-list');
    const limit = showAll.has(p.path) ? p.sessions.length : 8;
    for (const s of p.sessions.slice(0, limit)) {
      const row = el('div', 'sess');
      row.title = `${s.title}\n이어서 열기 (claude --resume)`;
      row.append(el('span', 'stitle', s.title), el('span', 'when', ago(s.mtime)));
      row.onclick = () => { newTab(true, { cwd: p.path, resume: s.id, title: s.title.slice(0, 30) }); if (narrow()) toggleSide(false); };
      list.append(row);
    }
    if (p.sessions.length > limit) {
      const more = el('div', 'sess-more', `이전 대화 ${p.sessions.length - limit}개 더 보기`);
      more.onclick = () => { showAll.add(p.path); renderProjects(); };
      list.append(more);
    }
    if (!p.sessions.length) list.append(el('div', 'side-empty', '아직 대화가 없어요'));
    wrap.append(head, list);
    return wrap;
  }));
}

const narrow = () => matchMedia('(max-width: 800px)').matches;
function toggleSide(show) {
  const hidden = show === undefined ? !document.body.classList.contains('side-hidden') : !show;
  document.body.classList.toggle('side-hidden', hidden);
  if (!narrow()) store('zd-side', hidden ? '0' : '1');
  if (!hidden) send({ t: 'projects' });
  requestAnimationFrame(() => { if (active !== null) sessions.get(active)?.fit.fit(); });
}
if (narrow() || load('zd-side') === '0') document.body.classList.add('side-hidden');
$('#side-toggle').onclick = () => toggleSide();
$('#refresh-projects').onclick = () => send({ t: 'projects' });
$('#add-folder').onclick = () => {
  const p = prompt('추가할 폴더 경로 (예: X:\\Github\\내프로젝트)');
  if (p) { send({ t: 'addfolder', path: p }); setTimeout(() => send({ t: 'projects' }), 300); }
};
setInterval(() => { if (!document.body.classList.contains('side-hidden')) send({ t: 'projects' }); }, 60000);

/** The app-level action for a key event, or null if the key belongs to the terminal. */
function shortcutFor(e) {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') return () => newTab(true);
  if (e.ctrlKey && !e.shiftKey && e.code === 'KeyB') return () => toggleSide();
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyW') return () => { if (active !== null) closeTab(active); };
  if (e.ctrlKey && e.key === 'Tab') return () => {
    const ids = [...sessions.keys()];
    if (ids.length) activate(ids[(ids.indexOf(active) + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
  };
  if (e.ctrlKey && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) return () => {
    fontSize = e.key === '0' ? (touch ? 12 : 14) : Math.min(28, Math.max(8, fontSize + (e.key === '-' ? -1 : 1)));
    store('zd-font', String(fontSize));
    for (const s of sessions.values()) s.term.options.fontSize = fontSize;
    if (active !== null) activate(active);
  };
  return null;
}
/** Terminal side: only claims the key; the window listener below runs the action once. */
function globalShortcut(e) { return shortcutFor(e) !== null; }
addEventListener('keydown', (e) => {
  const act = shortcutFor(e);
  if (act) { e.preventDefault(); act(); }
});

// ---- messages ----
function onSessions(list) {
  const seen = new Set();
  let created = null;
  for (const info of list) {
    seen.add(info.id);
    const s = sessions.get(info.id);
    if (s) s.info = info; else { makeSession(info); created = info.id; }
  }
  // A tab we asked for just appeared: switch to it.
  if (created !== null && wantActivate > 0) {
    wantActivate--;
    for (const id of [...sessions.keys()]) if (!seen.has(id)) dropSession(id);
    activate(created);
    return;
  }
  for (const id of [...sessions.keys()]) if (!seen.has(id)) dropSession(id);
  if (active === null || !sessions.has(active)) {
    const last = [...sessions.keys()].pop();
    if (last !== undefined) { activate(last); return; }
  }
  // Desktop window with nothing open: start a Claude tab right away.
  if (!list.length && !autoCreated && isDesktop && !p2pMode) { autoCreated = true; newTab(true); }
  renderTabs();
}

function onRemote(m) {
  $('#remote-on').checked = m.on;
  $('#remote-btn').classList.toggle('on', m.on);
  const box = $('#remote-urls');
  box.replaceChildren(...m.urls.map((u) => Object.assign(document.createElement('a'), { href: u, textContent: u, target: '_blank' })));
  if (m.on && !m.urls.length) box.textContent = `포트 ${m.port} 에서 대기 중 (LAN IP를 찾지 못했어요)`;

  $('#web-url').textContent = (m.web_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const list = $('#paired');
  list.replaceChildren(...(m.paired || []).map((d) => {
    const row = Object.assign(document.createElement('div'), { className: 'device' });
    const name = Object.assign(document.createElement('span'), { textContent: `📱 ${d.name}` });
    name.title = d.pubkey;
    const del = Object.assign(document.createElement('button'), { textContent: '연결 해제' });
    del.onclick = () => { if (confirm(`${d.name} 의 접속 권한을 지울까요?`)) send({ t: 'unpair', pubkey: d.pubkey }); };
    row.append(name, del);
    return row;
  }));
  $('#peers').textContent = m.peers ? `지금 P2P로 연결된 기기: ${m.peers}대` : '';
  // A device just paired (the QR is single-use): hide it.
  if ((m.paired || []).length > pairedCount && !$('#pair-box').hidden) { $('#pair-box').hidden = true; toast('기기가 연결됐어요'); }
  pairedCount = (m.paired || []).length;
}

let pairedCount = 0;
let pairTimer = 0;
function onPairing(m) {
  $('#pair-qr').innerHTML = m.svg; // generated by our own server from our own URL
  $('#pair-box').hidden = false;
  const until = Date.now() + m.ttl * 1000;
  clearInterval(pairTimer);
  const tick = () => {
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    $('#pair-ttl').textContent = left ? `폰 카메라로 찍으세요 · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 동안 유효 · 한 번만 쓸 수 있어요` : 'QR이 만료됐어요';
    if (!left) { clearInterval(pairTimer); $('#pair-box').hidden = true; }
  };
  tick();
  pairTimer = setInterval(tick, 1000);
}

function onFrame(buf) {
  const dv = new DataView(buf);
  const id = dv.getUint32(0, true);
  const end = dv.getBigUint64(4, true);
  const replay = dv.getUint8(12) === 1;
  const s = sessions.get(id);
  if (!s) return;
  if (replay) { s.term.reset(); }
  else if (end <= s.end) return; // already contained in the replay we got
  s.end = end;
  s.term.write(new Uint8Array(buf, 13));
  if (!replay && id !== active && !s.unread) { s.unread = true; renderTabs(); }
}

// ---- connection ----
function showEmpty(text) {
  $('#terms .empty')?.remove();
  $('#terms').append(Object.assign(document.createElement('div'), { className: 'empty', textContent: text }));
}

function connect() {
  if (p2pMode) {
    if (!desk) { showEmpty('데스크탑 앱의 [리모트] → "새 기기 연결 QR"을 이 기기로 찍어 주세요'); return; }
    if (!sessions.size) showEmpty('데스크탑에 연결하는 중…');
    ws = ZDP2P.connect(desk.pub, desk.relays);
    ws.onstatus = (s) => { if (!sessions.size) showEmpty(s); };
  } else {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.binaryType = 'arraybuffer';
  }
  const sock = ws;
  ws.onopen = () => {
    retry = p2pMode ? 2000 : 500;
    $('#conn').className = 'dot on';
    if (p2pMode) toast('데스크탑에 연결됐어요', 2000);
    // Re-attach everything we already show: output during the gap is in the server's scrollback.
    for (const s of sessions.values()) send({ t: 'attach', id: s.id });
    if (!document.body.classList.contains('side-hidden')) send({ t: 'projects' });
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return onFrame(ev.data);
    const m = JSON.parse(ev.data);
    if (m.t === 'sessions') onSessions(m.list);
    else if (m.t === 'remote') onRemote(m);
    else if (m.t === 'pairing') onPairing(m);
    else if (m.t === 'projects') { projects = m.list; renderProjects(); }
    else if (m.t === 'error') toast(m.msg);
  };
  ws.onclose = (ev) => {
    $('#conn').className = 'dot off';
    if (sock.lastError && sock.lastError.denied) {
      store('zd-desk', ''); desk = null;
      showEmpty(sock.lastError.message);
      return;
    }
    if (p2pMode && ev && ev.reason && ev.reason !== 'channel closed') {
      toast(`${ev.reason} · ${Math.round(retry / 1000)}초 뒤 다시 시도`, retry);
    }
    setTimeout(connect, retry);
    // P2P retries cost relay round-trips: back off further.
    retry = Math.min(retry * 2, p2pMode ? 30000 : 5000);
  };
}

/** Opened from the desktop's pairing QR: `#d=<desk pubkey>&s=<secret>&r=<relays>`. */
async function pairFromHash() {
  const d = hash.get('d');
  const s = hash.get('s');
  if (!d || !s) return;
  history.replaceState(null, '', location.pathname + location.search);
  const relays = (hash.get('r') || '').split(',').filter(Boolean);
  showEmpty('데스크탑과 짝을 맺는 중…');
  try {
    if (await ZDP2P.pair(d, relays, s)) {
      desk = { pub: d, relays };
      store('zd-desk', JSON.stringify(desk));
      toast('짝 맺기 완료! 이 주소를 홈 화면에 추가해 두면 편해요', 5000);
    } else {
      showEmpty('QR이 만료됐거나 이미 사용됐어요. 데스크탑에서 새 QR을 만들어 주세요.');
    }
  } catch (e) {
    showEmpty(e.message);
  }
}

// ---- chrome ----
$('#new-claude').onclick = () => newTab(true);
$('#new-shell').onclick = () => newTab(false);
$('#remote-btn').onclick = () => { $('#remote').hidden = !$('#remote').hidden; };
// Remote settings belong to the desktop window only.
if (!isDesktop || p2pMode) $('#remote-btn').hidden = true;
$('#pair-btn').onclick = () => send({ t: 'pair' });
$('#remote-close').onclick = () => { $('#remote').hidden = true; };
$('#remote-on').onchange = (e) => send({ t: 'remote', on: e.target.checked });

const KEYS = { esc: '\x1b', tab: '\t', stab: '\x1b[Z', ctrlc: '\x03', nl: '\x1b\r', enter: '\r' };
for (const b of document.querySelectorAll('#keys button')) {
  b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the soft keyboard open
  b.addEventListener('click', () => {
    if (active === null) return;
    const k = b.dataset.k;
    const appCursor = sessions.get(active).term.modes.applicationCursorKeysMode;
    const arrow = { up: 'A', down: 'B' }[k];
    input(active, arrow ? (appCursor ? '\x1bO' : '\x1b[') + arrow : KEYS[k]);
  });
}

new ResizeObserver(() => { if (active !== null) sessions.get(active)?.fit.fit(); }).observe($('#terms'));
(async () => {
  if (p2pMode) await pairFromHash();
  connect();
})();
