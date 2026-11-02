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
// Only the desktop window sizes the shared PTY. Every other client (phone, LAN browser) shows the
// desktop's cols/rows, shrinking the font to fit, so the two never fight over the screen.
const follow = !isDesktop;
const hash = new URLSearchParams(location.hash.slice(1));
let desk = null; // { pub, relays } of the paired desktop
try { desk = JSON.parse(load('zd-desk') || 'null'); } catch {}

let toastTimer = 0;
function toast(msg, ms = 4000) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false; t.onclick = null;
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

// ---- theme: dark | light, per device (index.html applies it before the page paints) ----
const termThemes = {
  dark: {
    background: '#15161a', foreground: '#d8dae0', cursor: '#d97757', selectionBackground: '#3a4050',
    black: '#1e2026', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef',
    magenta: '#c678dd', cyan: '#56b6c2', white: '#d8dae0', brightBlack: '#5c6370',
  },
  light: {
    background: '#ffffff', foreground: '#1f2329', cursor: '#c96442', cursorAccent: '#ffffff',
    selectionBackground: '#c9d7f2',
    black: '#1f2329', red: '#c9372c', green: '#2f8a3e', yellow: '#9a6a00', blue: '#2f6fe0',
    magenta: '#a3329e', cyan: '#0f7c8c', white: '#8b919c',
    brightBlack: '#646b78', brightRed: '#e0483c', brightGreen: '#3a9e4a', brightYellow: '#b07d0a',
    brightBlue: '#4a84ea', brightMagenta: '#b84bb3', brightCyan: '#1690a2', brightWhite: '#b4bac4',
  },
};
let themeName = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
const termTheme = () => termThemes[themeName];
/** The desktop window also recolors its title bar (the server hands it to the window). */
function syncWindowTheme() { if (isDesktop && !p2pMode) send({ t: 'theme', theme: themeName }); }
function setTheme(name) {
  themeName = name === 'light' ? 'light' : 'dark';
  store('zd-theme', themeName);
  document.documentElement.dataset.theme = themeName;
  for (const s of sessions.values()) s.term.options.theme = termTheme();
  syncWindowTheme();
  renderThemePane();
}
function renderThemePane() {
  for (const b of document.querySelectorAll('.theme-opt')) b.classList.toggle('on', b.dataset.theme === themeName);
}

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
  el.className = follow ? 'term follow' : 'term';
  $('#terms').append(el);
  const term = new Terminal({
    fontFamily: "'Cascadia Mono', 'D2Coding', Consolas, 'Malgun Gothic', monospace",
    fontSize, scrollback: 10000, cursorBlink: true, allowProposedApi: true, theme: termTheme(),
    macOptionIsMeta: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);

  const s = { id: info.id, term, fit, el, end: -1n, info, osTitle: '', unread: false, done: false };
  term.onData((d) => input(s.id, d));
  if (!follow) term.onResize(({ cols, rows }) => { if (active === s.id) send({ t: 'resize', id: s.id, cols, rows }); });
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
    // Typing into the terminal while the input box is shown (a menu in conversation mode): move
    // focus there so the key (focus changes during keydown carry the character along) lands in the box.
    if (composeShown() && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key.length === 1 || e.key === 'Process')) {
      ta.focus();
      return false;
    }
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

/** Fits the active tab's terminal to its box (see [`fitTerm`]). */
function fitActive() {
  const s = active !== null && sessions.get(active);
  if (s) fitTerm(s);
}

/**
 * The desktop window fits the terminal to its box and the PTY follows. Other clients keep the
 * desktop's cols/rows and shrink the font until that width fits (never below 6px; the box
 * scrolls for the rest), so a phone shows the same screen without resizing it.
 */
function fitTerm(s) {
  if (!follow) { s.fit.fit(); return; }
  const { cols, rows } = s.info;
  if (!cols || !rows) { s.fit.fit(); return; } // older desktop app: no size to follow
  if (s.term.cols !== cols || s.term.rows !== rows) s.term.resize(cols, rows);
  let size = fontSize;
  s.term.options.fontSize = size;
  for (let i = 0; i < 4 && size > 6; i++) {
    const p = s.fit.proposeDimensions();
    if (!p || p.cols >= cols) break;
    size = Math.max(6, Math.floor(size * p.cols / cols));
    s.term.options.fontSize = size;
  }
}

function dropSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.term.dispose(); s.el.remove(); sessions.delete(id);
  drafts.delete(id);
  queued.delete(id);
  if (draftOf === id) draftOf = null;
  if (active === id) active = null;
}

function activate(id) {
  const s = sessions.get(id);
  if (!s) return;
  active = id;
  s.unread = false;
  s.done = false;
  if (draftOf !== id) swapDraft(id);
  for (const o of sessions.values()) o.el.classList.toggle('active', o.id === id);
  requestAnimationFrame(() => {
    fitTerm(s);
    // Show the latest output, fully repainted.
    s.term.scrollToBottom();
    s.term.refresh(0, s.term.rows - 1);
    // Tell the server which tab is on screen: the desktop by sizing it, followers by saying so.
    if (!follow) send({ t: 'resize', id, cols: s.term.cols, rows: s.term.rows });
    else if (s.info.cols) send({ t: 'view', id }); // an older desktop app knows neither 'view' nor its size
    focusInput();
  });
  renderTabs();
  syncChat(true);
  updateSend();
  if (projects.length) renderProjects(); // highlight the conversation now shown
}

/** No tab bar any more (the sidebar lists conversations); this only keeps the empty-state hint. */
function renderTabs() {
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
  if (claude) extra = { model: curModel(), effort: curEffort(), ...extra };
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

const samePath = (a, b) => {
  const n = (s) => (s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
};

// Project order is the user's: only drag-and-drop changes it. The server lists by recency,
// so known folders keep their saved slot and newly seen ones go on top.
let projOrder = [];
try { projOrder = JSON.parse(load('zd-proj-order') || '[]'); } catch {}
const pkey = (s) => (s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
function applyProjOrder() {
  const rank = new Map(projOrder.map((k, i) => [k, i]));
  const fresh = projects.filter((p) => !rank.has(pkey(p.path)));
  const known = projects.filter((p) => rank.has(pkey(p.path)))
    .sort((a, b) => rank.get(pkey(a.path)) - rank.get(pkey(b.path)));
  projects = [...fresh, ...known];
  saveProjOrder();
}
function saveProjOrder() {
  // Keep folders not in this listing too, so a temporarily missing one doesn't lose its slot.
  const now = projects.map((p) => pkey(p.path));
  const seen = new Set(now);
  projOrder = [...now, ...projOrder.filter((k) => !seen.has(k))];
  store('zd-proj-order', JSON.stringify(projOrder));
}
let dragProj = null; // path being dragged; re-renders wait until the drag ends
let renderPending = false;

function renderProjects() {
  if (dragProj !== null) { renderPending = true; return; }
  const box = $('#projects');
  if (!projects.length) { box.replaceChildren(el('div', 'side-empty', 'Claude 대화 기록이 없어요. ＋로 폴더를 추가하세요.')); return; }
  // Plain shell tabs have no conversation to list; without the tab bar this is the way back to them.
  const shells = [...sessions.values()].filter((s) => !s.info.claude);
  const shellBox = [];
  if (shells.length) {
    const wrap = el('div', 'proj open');
    wrap.append(el('div', 'proj-head', '셸'));
    const list = el('div', 'proj-list');
    for (const s of shells) {
      const row = el('div', 'sess' + (s.id === active ? ' current' : ''));
      row.append(el('span', 'sdot'), el('span', 'stitle', s.osTitle || s.info.title));
      const x = el('button', 'icon', '×');
      x.title = '셸 닫기';
      x.onclick = (e) => { e.stopPropagation(); closeTab(s.id); };
      row.append(x);
      row.onclick = () => { activate(s.id); if (narrow()) toggleSide(false); };
      list.append(row);
    }
    wrap.append(list);
    shellBox.push(wrap);
  }
  box.replaceChildren(...shellBox, ...projects.map((p) => {
    const wrap = el('div', 'proj' + (openProjects.has(p.path) ? ' open' : ''));
    const head = el('div', 'proj-head');
    head.title = p.path;
    const caret = el('span', 'caret', openProjects.has(p.path) ? '▾' : '▸');
    const name = el('span', 'pname', p.name);
    const add = el('button', 'icon new', '＋');
    add.title = `${p.name} 에서 새 대화`;
    add.onclick = (e) => { e.stopPropagation(); newTab(true, { cwd: p.path, title: p.name }); };
    // Blue badge = conversations in this folder that finished and you haven't opened yet (the rows' blue dots).
    // Only while collapsed: once open, the rows' own dots already say it.
    const doneN = [...sessions.values()].filter((s) => s.done && !s.info.busy && samePath(s.info.cwd, p.path)).length;
    head.append(caret, name);
    if (doneN && !openProjects.has(p.path)) {
      const badge = el('span', 'run-badge done', String(doneN));
      badge.title = `작업 끝남 · 안 본 대화 ${doneN}개`;
      head.append(badge);
    }
    head.append(add);
    head.onclick = () => {
      openProjects.has(p.path) ? openProjects.delete(p.path) : openProjects.add(p.path);
      store('zd-open', JSON.stringify([...openProjects]));
      renderProjects();
    };
    head.draggable = true;
    head.ondragstart = (e) => {
      dragProj = p.path;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.path);
      wrap.classList.add('dragging');
    };
    head.ondragend = () => {
      dragProj = null;
      box.querySelectorAll('.drop-before, .drop-after, .dragging')
        .forEach((n) => n.classList.remove('drop-before', 'drop-after', 'dragging'));
      if (renderPending) { renderPending = false; renderProjects(); }
    };
    const after = (e) => { const r = wrap.getBoundingClientRect(); return e.clientY > r.top + Math.min(r.height, head.offsetHeight) / 2; };
    wrap.ondragover = (e) => {
      if (dragProj === null || samePath(dragProj, p.path)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const a = after(e);
      wrap.classList.toggle('drop-after', a);
      wrap.classList.toggle('drop-before', !a);
    };
    wrap.ondragleave = (e) => {
      if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('drop-before', 'drop-after');
    };
    wrap.ondrop = (e) => {
      if (dragProj === null || samePath(dragProj, p.path)) return;
      e.preventDefault();
      e.stopPropagation();
      const from = projects.findIndex((q) => samePath(q.path, dragProj));
      if (from < 0) return;
      const [moved] = projects.splice(from, 1);
      let to = projects.findIndex((q) => samePath(q.path, p.path));
      if (after(e)) to++;
      projects.splice(to, 0, moved);
      saveProjOrder();
      renderPending = true; // dragend re-renders
    };
    const list = el('div', 'proj-list');
    const limit = showAll.has(p.path) ? p.sessions.length : 8;
    for (const s of p.sessions.slice(0, limit)) {
      // The tab running this conversation: as matched by the server, or one we opened with --resume
      // (covers the moment before the next projects refresh).
      const tab = (s.tab != null && sessions.get(s.tab))
        || [...sessions.values()].find((t) => t.info.alive && t.info.resume === s.id);
      const busy = tab && tab.info.busy;
      const done = !busy && tab && tab.done;
      const row = el('div', 'sess' + (tab && tab.id === active ? ' current' : '') + (busy ? ' busy' : ''));
      row.title = s.title;
      // Right slot: the CLI-style spinner while working → a blue dot once it finishes (until opened)
      // → last-modified time.
      let when;
      if (done) when = el('span', 'done-dot');
      else if (busy) {
        when = el('span', 'when sspin');
        when.append(el('span', 'sglyph'), el('span', 'sverb', '작업 중…'));
      } else when = el('span', 'when', ago(s.mtime));
      if (done) when.title = '작업 끝남 · 아직 안 봤어요';
      row.append(el('span', 'sdot'), el('span', 'stitle', s.title), when);
      row.onclick = () => {
        if (tab) activate(tab.id);
        else newTab(true, { cwd: p.path, resume: s.id, title: s.title.slice(0, 30) });
        if (narrow()) toggleSide(false);
      };
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
  requestAnimationFrame(() => { if (active !== null) fitActive(); });
}
// The sidebar is how conversations are picked, so it starts open on wide screens.
if (narrow()) document.body.classList.add('side-hidden');
$('#side-toggle').onclick = () => toggleSide();
$('#refresh-projects').onclick = () => send({ t: 'projects' });
// Desktop window: the server opens a native folder dialog. Other devices can't see this
// PC's dialog, so the server answers {remote:true} and they type a path instead.
$('#add-folder').onclick = () => send({ t: 'pickfolder' });
function onFolder(m) {
  if (m.remote) {
    const p = prompt('추가할 폴더 경로 (예: X:\\Github\\내프로젝트)');
    if (p) { send({ t: 'addfolder', path: p }); setTimeout(() => send({ t: 'projects' }), 300); }
  } else if (m.path) send({ t: 'projects' });
}
setInterval(() => { if (!document.body.classList.contains('side-hidden')) send({ t: 'projects' }); }, 60000);

/** The app-level action for a key event, or null if the key belongs to the terminal. */
function shortcutFor(e) {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') return () => newTab(true);
  if (e.ctrlKey && !e.shiftKey && e.code === 'KeyB') return () => toggleSide();
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyY') return () => setChatPref(!chatPref);
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyW') return () => { if (active !== null) closeTab(active); };
  if (e.ctrlKey && e.key === 'Tab') return () => {
    const ids = [...sessions.keys()];
    if (ids.length) activate(ids[(ids.indexOf(active) + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
  };
  if (e.ctrlKey && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) return () => {
    fontSize = e.key === '0' ? (touch ? 12 : 14) : Math.min(28, Math.max(8, fontSize + (e.key === '-' ? -1 : 1)));
    store('zd-font', String(fontSize));
    for (const s of sessions.values()) s.term.options.fontSize = fontSize;
    if (follow) fitActive();
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
// ---- "Claude finished" notifications ----
// Asked on the first click/key (browsers only allow the prompt after a user gesture).
const canNotify = typeof Notification !== 'undefined';
addEventListener('pointerdown', () => {
  if (canNotify && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}, { once: true });

/** A Claude tab went from working to idle. Quiet if you are already looking at that tab. */
function notifyDone(s) {
  const watching = s.id === active && document.hasFocus();
  if (watching) return;
  s.unread = true;
  s.done = true; // blue dot in the sidebar until you open it
  const name = (s.osTitle || s.info.title).replace(/^[⠀-⣿✳*·\s]+/, '').slice(0, 40) || 'Claude';
  toast(`✓ ${name} 작업이 끝났어요`, 6000);
  const t = $('#toast');
  t.onclick = () => { activate(s.id); t.hidden = true; };
  if (canNotify && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
    try {
      const n = new Notification('작업 끝남', { body: name, tag: `zd-${s.id}` });
      n.onclick = () => { focus(); activate(s.id); n.close(); };
    } catch {}
  }
}

/** Projects list refresh, coalesced (tab opened/closed, or a conversation just got written). */
let projTimer = 0;
function refreshProjectsSoon() {
  if (document.body.classList.contains('side-hidden')) return;
  clearTimeout(projTimer);
  projTimer = setTimeout(() => send({ t: 'projects' }), 800);
}

function onSessions(list) {
  const seen = new Set();
  let created = null;
  let refresh = false;
  for (const info of list) {
    seen.add(info.id);
    const s = sessions.get(info.id);
    if (s) {
      const was = s.info.busy;
      const resized = s.info.cols !== info.cols || s.info.rows !== info.rows;
      if (!info.asking && termPeek === info.id) termPeek = null; // the menu is answered: back to the chat
      s.info = info;
      if (follow && resized && info.id === active) fitTerm(s);
      if (was && !info.busy) { notifyDone(s); refresh = true; }
      if (!was && info.busy) { s.done = false; refresh = true; } // a new conversation's transcript appears once it starts
    } else { makeSession(info); created = info.id; refresh = true; }
  }
  if ([...sessions.keys()].some((id) => !seen.has(id))) refresh = true;
  if (refresh) refreshProjectsSoon();
  if (projects.length) renderProjects();
  syncChat(false); // a menu appeared/went away, or the working state changed
  updateSend();
  flushQueues();
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

/** Only a tab's live status lines changed: just the working indicator, no list re-render. */
function onLive(m) {
  const s = sessions.get(m.id);
  if (!s) return;
  s.info.live = m.live;
  if (m.id === active) updateChatWorking(s);
}

function onRemote(m) {
  $('#remote-on').checked = m.on;
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

// ---- app updates (desktop window only; the server downloads and verifies) ----
const canUpdate = isDesktop && !p2pMode;
let upd = null;
let requiredShown = false;

function updAction(action) { send({ t: 'update', action }); }
$('#upd-dev').onchange = (e) => updAction(e.target.checked ? 'channel_dev' : 'channel_stable');

function onUpdate(m) {
  if (!canUpdate) return;
  upd = m;
  const b = $('#update-btn');
  b.hidden = !m.available;
  b.className = 'act' + (m.required ? ' required' : '') + (m.state === 'downloading' ? ' busy' : '');
  const working = [...sessions.values()].filter((s) => s.info.busy || s.info.asking).length;
  b.textContent = m.when_idle ? (working ? '작업 끝나면 업데이트' : '곧 업데이트')
    : m.state === 'downloading' ? `업데이트 받는 중 ${m.progress}%`
    : m.state === 'ready' ? (m.on_exit ? '끌 때 업데이트' : '업데이트 준비됨')
    : m.required ? '필수 업데이트' : `업데이트 v${m.latest}`;
  b.title = m.required ? '이 버전은 지원이 끝났어요. 업데이트해 주세요.' : '새 버전 정보 보기';
  // A required update opens the panel once by itself.
  if (m.required && m.available && !requiredShown) { requiredShown = true; openSettings('update'); }
  renderUpdate();
}

function renderUpdate() {
  const m = upd;
  if (!m || !paneOpen('update')) return;
  const tabs = [...sessions.values()].filter((s) => s.info.alive).length;
  const working = [...sessions.values()].filter((s) => s.info.busy || s.info.asking).length;
  $('#upd-title').textContent = m.required && m.available ? '필수 업데이트' : m.available ? '새 버전이 있어요' : '업데이트';
  $('#upd-ver').textContent = m.available
    ? `v${m.current} → v${m.latest}${m.pub_date ? ` · ${m.pub_date.slice(0, 10)}` : ''}`
    : `v${m.current}${m.latest && m.state !== 'error' ? ' · 최신 버전이에요' : ''}`;
  $('#upd-notes').replaceChildren(...(m.available ? m.notes : []).map((n) => el('li', '', n)));
  $('#upd-bar').hidden = m.state !== 'downloading';
  $('#upd-bar > div').style.width = `${m.progress}%`;

  const workingNote = working ? `지금 작업 중인 대화 ${working}개.` : '작업 중인 대화가 없어요.';
  const state = m.when_idle
    ? (m.state === 'downloading' ? `받는 중 ${m.progress}% · ` : '')
      + (working ? `작업 중인 대화 ${working}개가 끝나면 자동으로 설치하고 다시 시작해요.` : '곧 설치하고 다시 시작해요…')
    : {
      checking: '확인하는 중…',
      downloading: `받는 중 ${m.progress}% (검증까지 끝나면 설치할 수 있어요)`,
      ready: m.on_exit ? '앱을 끌 때 설치돼요.' : `받아 뒀어요. ${workingNote}`,
    }[m.state] || (m.available && m.dev ? '개발 빌드라 자동으로 받지 않아요.' : '');
  const checked = m.checked_at ? `마지막 확인 ${ago(m.checked_at)}${ago(m.checked_at) === '방금' ? '' : ' 전'}` : '';
  $('#upd-state').textContent = [m.required && m.available ? '이 버전은 지원이 끝났어요.' : '', state, checked].filter(Boolean).join(' · ');
  $('#upd-dev').checked = m.channel === 'dev';
  if (m.available && m.latest_channel === 'dev') $('#upd-ver').textContent += ' (개발 버전)';
  $('#upd-error').hidden = !m.error;
  $('#upd-error').textContent = m.error || '';

  const btn = (text, cls, fn, disabled) => {
    const x = el('button', cls, text);
    x.type = 'button';
    x.disabled = !!disabled;
    x.onclick = fn;
    return x;
  };
  const busy = m.state === 'checking' || m.state === 'downloading';
  const acts = [];
  if (m.when_idle) {
    acts.push(btn('예약 취소', 'act ghost', () => updAction('cancel_when_idle')));
  } else if (m.available) {
    // Main choice: wait for the running conversations, then install by itself. With nothing
    // working that is right away (download, then a few seconds of idle).
    acts.push(working
      ? btn(`작업 ${working}개 끝나면 업데이트`, 'act', () => updAction('install_when_idle'))
      : btn('지금 업데이트', 'act', () => {
        if (tabs && !confirm(`열린 탭 ${tabs}개가 닫혀요(대화는 사이드바에서 다시 열 수 있어요). 지금 업데이트할까요?`)) return;
        updAction('install_when_idle');
      }));
    if (m.state === 'ready') {
      if (working) acts.push(btn('지금 바로 설치', 'act ghost', () => {
        if (!confirm(`작업 중인 대화 ${working}개가 중단돼요. 지금 업데이트할까요?`)) return;
        updAction('install_now');
      }));
      acts.push(m.on_exit
        ? btn('끌 때 설치 취소', 'act ghost', () => updAction('cancel_on_exit'))
        : btn('앱 끌 때 설치', 'act ghost', () => updAction('install_on_exit')));
    } else {
      acts.push(btn('받기', 'act ghost', () => updAction('download'), busy));
    }
  }
  acts.push(btn('다시 확인', 'act ghost', () => updAction('check'), busy));
  $('#upd-actions').replaceChildren(...acts);
}

$('#update-btn').onclick = () => openSettings('update');

// ---- settings: skills, remote access, updates in one dialog ----
let pane = load('zd-pane') || 'skills';
const paneOk = (p) => !document.querySelector(`.set-nav [data-pane="${p}"]`).hidden;
function paneOpen(p) { return !$('#settings').hidden && pane === p; }

function openSettings(p = pane) {
  if (!paneOk(p)) p = 'skills';
  pane = p;
  store('zd-pane', p);
  $('#settings').hidden = false;
  for (const b of document.querySelectorAll('.set-nav [data-pane]')) b.classList.toggle('on', b.dataset.pane === p);
  for (const s of document.querySelectorAll('#settings .pane')) s.hidden = s.id !== p;
  $('.set-body').scrollTop = 0;
  if (p === 'skills') showSkills();
  if (p === 'update') {
    // Opening the pane is the "check for updates" button.
    if (upd && upd.state !== 'checking' && upd.state !== 'downloading' && !upd.when_idle) updAction('check');
    renderUpdate();
  }
}
function closeSettings() { $('#settings').hidden = true; focusInput(); }

for (const b of document.querySelectorAll('.set-nav [data-pane]')) b.onclick = () => openSettings(b.dataset.pane);
for (const b of document.querySelectorAll('.theme-opt')) b.onclick = () => setTheme(b.dataset.theme);
renderThemePane();
$('#settings-btn').onclick = () => ($('#settings').hidden ? openSettings() : closeSettings());
$('#settings-close').onclick = closeSettings;
$('#settings').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) closeSettings(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#settings').hidden) { e.preventDefault(); e.stopPropagation(); closeSettings(); } }, true);
// Remote access and updates belong to the desktop window only.
if (!canUpdate) document.querySelector('.set-nav [data-pane="update"]').hidden = true;
if (!isDesktop || p2pMode) document.querySelector('.set-nav [data-pane="remote"]').hidden = true;

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
    if (!desk) { showEmpty('데스크탑 앱의 [설정] → [리모트] → "새 기기 연결 QR"을 이 기기로 찍어 주세요'); return; }
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
    watching = undefined; // the server forgot what we watched: ask again
    syncChat(true);
    syncWindowTheme();
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return onFrame(ev.data);
    const m = JSON.parse(ev.data);
    if (m.t === 'sessions') onSessions(m.list);
    else if (m.t === 'live') onLive(m);
    else if (m.t === 'remote') onRemote(m);
    else if (m.t === 'pairing') onPairing(m);
    else if (m.t === 'uploaded') onUploaded(m);
    else if (m.t === 'folder') onFolder(m);
    else if (m.t === 'update') onUpdate(m);
    else if (m.t === 'usage') onUsage(m);
    else if (m.t === 'projects') {
      projects = m.list; applyProjOrder(); renderProjects();
      if (paneOpen('skills')) { const had = skCwd; renderSkillScope(); if (skScope === 'local' && !had && skCwd) skRequest(); }
    }
    else if (m.t === 'chat') onChat(m);
    else if (m.t === 'skills') onSkills(m);
    else if (m.t === 'skill_done') onSkillDone(m);
    // An older desktop app without the chat stream: stay on the terminal.
    else if (m.t === 'error' && /watch/.test(m.msg)) { chatUnsupported = true; syncChat(true); }
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

// ---- input box ----
// Part of conversation mode: a plain textarea under the conversation with native selection,
// Ctrl+A, Shift+arrows, IME and image attachments. Enter sends the whole thing to the active tab;
// with the box empty, keys Claude Code's menus need (arrows, Enter, Esc, Tab) go straight to the
// terminal. Command mode has no box: you type into the terminal itself.
const ta = $('#compose-text');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drafts = new Map(); // session id -> unsent text
/** @type {Map<number, {text:string, atts:any[]}[]>} messages held until that Claude tab finishes */
const queued = new Map();
let draftOf = null;       // session whose text is in the box now
/** @type {{uid:string, url:string, path:string|null}[]} */
let atts = [];
let sendWhenUploaded = false;
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const UPLOAD_MAX = 20 * 1024 * 1024;

/** The box shows on Claude tabs in conversation mode (also while a menu brings the terminal up). */
function composeShown() {
  const s = active !== null && sessions.get(active);
  return !!(chatPref && s && s.info.claude);
}

function focusInput() {
  if (touch || active === null || !$('#settings').hidden) return;
  if (composeShown()) ta.focus(); else sessions.get(active)?.term.focus();
}

/** Keeps each tab's unsent text when switching tabs. */
function swapDraft(id) {
  if (draftOf !== null) drafts.set(draftOf, ta.value);
  draftOf = id;
  ta.value = drafts.get(id) || '';
  growInput();
}

function growInput() {
  updateSend();
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
  // A scrollbar only once the text outgrows max-height; otherwise it shows up on one line.
  ta.style.overflowY = ta.scrollHeight > ta.clientHeight + 1 ? 'auto' : 'hidden';
}

function renderAtts() {
  updateSend();
  $('#attach-list').replaceChildren(...atts.map((a) => {
    const box = el('div', 'att' + (a.path ? '' : ' busy'));
    const img = Object.assign(document.createElement('img'), { src: a.url, alt: '' });
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.title = '첨부 빼기';
    x.onclick = () => removeAtt(a);
    box.append(img, x);
    box.title = a.path || '올리는 중…';
    return box;
  }));
}

function removeAtt(a) {
  atts = atts.filter((o) => o !== a);
  URL.revokeObjectURL(a.url);
  renderAtts();
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
  return btoa(s);
}

/** Uploads an image to the desktop in chunks (data channel messages must stay small). */
async function addImage(file) {
  const ext = IMG_EXT[file.type];
  if (!ext) { toast('PNG·JPG·GIF·WebP 이미지만 첨부할 수 있어요'); return; }
  if (file.size > UPLOAD_MAX) { toast('이미지가 너무 커요 (최대 20MB)'); return; }
  const uid = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const a = { uid, url: URL.createObjectURL(file), path: null };
  atts.push(a);
  renderAtts();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 32 * 1024;
  for (let seq = 0, off = 0; ; seq++, off += CHUNK) {
    if (!atts.includes(a)) return; // removed while uploading
    while (ws && ws.readyState === 1 && ws.bufferedAmount > (1 << 20)) await sleep(30);
    if (!ws || ws.readyState !== 1) { removeAtt(a); toast('연결이 끊겨 이미지를 못 올렸어요'); return; }
    const last = off + CHUNK >= bytes.length;
    send({ t: 'upload', uid, seq, last, ext, d: toBase64(bytes.subarray(off, off + CHUNK)) });
    if (last) return;
  }
}

function onUploaded(m) {
  const a = atts.find((o) => o.uid === m.uid);
  if (!a) return;
  if (m.error) { removeAtt(a); toast(m.error); sendWhenUploaded = false; return; }
  a.path = m.path;
  renderAtts();
  if (sendWhenUploaded && atts.every((o) => o.path)) { sendWhenUploaded = false; sendCompose(); }
}

/** Sends the box to the active tab: images as pasted paths (Claude Code turns them into
 *  [Image #n]), then the text (multi-line as one bracketed paste), then Enter. */
async function sendCompose() {
  if (active === null) return;
  const s = sessions.get(active);
  const text = ta.value.replace(/\r\n/g, '\n');
  if (atts.some((a) => !a.path)) { sendWhenUploaded = true; toast('이미지를 다 올리면 보낼게요', 2000); return; }
  if (!text && !atts.length) { input(s.id, '\r'); return; } // empty Enter: confirm menus etc.
  const sent = atts;
  atts = [];
  ta.value = '';
  drafts.delete(s.id);
  growInput();
  renderAtts();
  await deliver(s, text, sent);
}

/** Types a message into a tab: image paths, the text, then Enter. */
async function deliver(s, text, sent) {
  s.sentAt = Date.now();
  const bp = s.term.modes.bracketedPasteMode;
  const paste = (t) => input(s.id, bp ? `\x1b[200~${t}\x1b[201~` : t);
  for (const a of sent) {
    paste(/\s/.test(a.path) ? `"${a.path}"` : a.path);
    if (!bp) input(s.id, ' ');
    await sleep(80);
    URL.revokeObjectURL(a.url);
  }
  if (text.includes('\n')) bp ? paste(text) : input(s.id, text.replace(/\n/g, '\r'));
  else if (text) input(s.id, text);
  // Let the TUI absorb the paste before Enter, or it may land inside it.
  await sleep(text.length > 200 || sent.length ? 150 : 30);
  input(s.id, '\r');
}

/** Keys that go to the terminal instead of the box. */
function passKey(e) {
  const empty = !ta.value && !atts.length;
  if (e.key === 'Escape') return '\x1b';
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) return e.shiftKey ? '\x1b[Z' : '\t';
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC' && ta.selectionStart === ta.selectionEnd) return '\x03';
  if (empty && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    moveMenuSel(e.key === 'ArrowUp' ? -1 : 1);
    const app = sessions.get(active)?.term.modes.applicationCursorKeysMode;
    return (app ? '\x1bO' : '\x1b[') + (e.key === 'ArrowUp' ? 'A' : 'B');
  }
  return null;
}

ta.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME is composing (Korean etc.)
  if (active === null) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !touch) {
    e.preventDefault();
    sendCompose();
    return;
  }
  const seq = passKey(e);
  if (seq !== null) { e.preventDefault(); input(active, seq); }
});
ta.addEventListener('input', growInput);
ta.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  files.forEach(addImage);
});
$('#compose').addEventListener('submit', (e) => { e.preventDefault(); sendCompose(); ta.focus(); });
$('#attach-btn').onclick = () => $('#attach-file').click();
$('#attach-file').onchange = (e) => { [...e.target.files].forEach(addImage); e.target.value = ''; ta.focus(); };

// ---- send / stop buttons ----
// Idle: → sends. Claude working, box empty: ■ stops it (Esc). Claude working and something typed:
// "바로 전송" (= Enter; Claude Code takes it in mid-turn) or "끝나면 전송" (held here, sent once it's done).
function workingTab() {
  const s = active !== null && sessions.get(active);
  return s && s.info.claude && s.info.alive && s.info.busy ? s : null;
}
function updateSend() {
  const busy = !!workingTab();
  const has = !!(ta.value.trim() || atts.length);
  $('#send-btn').hidden = busy;
  $('#stop-btn').hidden = !busy || has;
  $('#now-btn').hidden = !busy || !has;
  $('#queue-btn').hidden = !busy || !has;
  renderQueue();
}
function renderQueue() {
  const list = (active !== null && queued.get(active)) || [];
  $('#queue-list').replaceChildren(...list.map((q) => {
    const row = el('div', 'qi');
    const x = el('button', '', '×');
    x.type = 'button';
    x.title = '보내지 않기';
    x.onclick = () => {
      const l = queued.get(active) || [];
      l.splice(l.indexOf(q), 1);
      for (const a of q.atts) URL.revokeObjectURL(a.url);
      renderQueue();
    };
    row.append('끝나면 전송', el('span', '', (q.atts.length ? `🖼${q.atts.length} ` : '') + q.text.replace(/\s+/g, ' ')), x);
    return row;
  }));
}
function holdCompose() {
  const s = workingTab();
  if (!s) { sendCompose(); return; }
  if (atts.some((a) => !a.path)) { toast('이미지를 다 올린 뒤에 눌러 주세요', 2000); return; }
  const text = ta.value.replace(/\r\n/g, '\n');
  if (!text.trim() && !atts.length) return;
  if (!queued.has(s.id)) queued.set(s.id, []);
  queued.get(s.id).push({ text, atts });
  atts = [];
  ta.value = '';
  drafts.delete(s.id);
  growInput();
  renderAtts();
  ta.focus();
}
/** Sends one held message to each tab that has finished (one at a time: it gets busy again). */
function flushQueues() {
  for (const [id, list] of queued) {
    const s = sessions.get(id);
    if (!list.length || !s) continue;
    if (!s.info.alive) { queued.delete(id); continue; }
    if (s.info.busy || s.info.asking || Date.now() - (s.sentAt || 0) < 3000) continue;
    const q = list.shift();
    deliver(s, q.text, q.atts);
  }
  renderQueue();
}
setInterval(flushQueues, 2000);
$('#stop-btn').onclick = () => { if (active !== null) input(active, '\x1b'); focusInput(); };
$('#now-btn').onclick = () => { sendCompose(); ta.focus(); };
$('#queue-btn').onclick = holdCompose;

// ---- AI model / effort picker (in the input box) ----
// Saved per device; every new Claude tab starts with `--model` / `--effort`. The active Claude tab,
// if it's idle, switches right away via `/model` · `/effort` (typing into a busy one would interrupt).
const MODELS = [['opus', 'Opus 5.5'], ['fable', 'Fable 5.1'], ['sonnet', 'Sonnet 5.5'], ['haiku', 'Haiku 5.5', '빠름']];
// Never picked (or an old saved '' = "default"): start with Opus.
function curModel() {
  const m = load('zd-model');
  return MODELS.some((x) => x[0] === m) ? m : 'opus';
}
const EFFORTS = [['low', 'Low', '빠름'], ['medium', 'Medium', ''], ['high', 'High', ''],
  ['xhigh', 'XHigh', ''], ['max', 'Max', '가장 꼼꼼']];
function curEffort() {
  const e = load('zd-effort');
  return EFFORTS.some((x) => x[0] === e) ? e : 'high';
}
const modelMenu = $('#model-menu');
function renderModel() {
  const m = curModel(), e = curEffort();
  $('#model-name').textContent = MODELS.find((x) => x[0] === m)[1];
  $('#model-eff').textContent = EFFORTS.find((x) => x[0] === e)[1];
  const item = (list, cur, pick) => list.map(([v, label, note]) => {
    const b = el('button', 'mm-i');
    b.type = 'button';
    const l = el('span', '', label);
    if (note) l.append(' ', el('small', '', note));
    b.append(l, el('span', 'ck', v === cur ? '✓' : ''));
    b.onclick = () => pick(v);
    return b;
  });
  $('#mm-models').replaceChildren(...item(MODELS, m, (v) => applyOpt('zd-model', 'model', v)));
  $('#mm-efforts').replaceChildren(...item(EFFORTS, e, (v) => applyOpt('zd-effort', 'effort', v)));
}
function showModelMenu(on) {
  modelMenu.hidden = !on;
  $('#model-btn').classList.toggle('open', on);
}
$('#model-btn').onclick = () => showModelMenu(modelMenu.hidden);
document.addEventListener('pointerdown', (e) => { if (!modelMenu.hidden && !e.target.closest('.mpick')) showModelMenu(false); });
modelMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); showModelMenu(false); focusInput(); } });
// ---- Claude plan usage (status line under the input box) ----
let usage = null;
function untilText(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return '곧';
  const min = Math.round(ms / 60000), h = Math.floor(min / 60), d = Math.floor(h / 24);
  if (d >= 1) return `${d}일 ${h % 24}시간 후`;
  if (h >= 1) return `${h}시간 ${min % 60}분 후`;
  return `${Math.max(1, min)}분 후`;
}
function whenText(iso) {
  const t = new Date(iso);
  return isNaN(t) ? '' : t.toLocaleString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
function renderUsage() {
  const el = $('#usage');
  const items = usage ? [
    ['세션', '5시간', usage.session],
    ['주간', '7일', usage.weekly],
    // Per-model weekly limits (e.g. Fable), counted apart from the all-models one.
    ...(usage.scoped || []).map((l) => [l.name, '7일', l]),
  ].filter(([, , l]) => l) : [];
  el.hidden = !items.length;
  if (!items.length) return;
  el.replaceChildren(...items.map(([name, , l]) => {
    const pct = Math.max(0, Math.min(100, Math.round(l.pct)));
    const span = document.createElement('span');
    span.className = 'u-item' + (pct >= 90 ? ' bad' : pct >= 70 ? ' warn' : '');
    const bar = document.createElement('i');
    bar.style.setProperty('--p', pct + '%');
    span.append(name + ' ', bar, ' ' + pct + '%');
    return span;
  }));
  el.title = items.map(([name, win, l]) => {
    const r = l.resets_at ? ` · ${untilText(l.resets_at)} 초기화 (${whenText(l.resets_at)})` : '';
    return `${name}(${win}) ${Math.round(l.pct)}% 사용${r}`;
  }).join('\n') + (usage.plan ? `\n플랜: ${usage.plan}` : '') + '\n클릭하면 지금 다시 확인해요';
}
function onUsage(m) { usage = m; renderUsage(); }
$('#usage').addEventListener('click', () => send({ t: 'usage' }));
// "N시간 후" in the tooltip goes stale between pushes.
setInterval(() => { if (usage) renderUsage(); }, 60000);

let optHintTimer = 0;
function optHint(msg) {
  $('#opt-hint').textContent = msg;
  clearTimeout(optHintTimer);
  optHintTimer = setTimeout(() => { $('#opt-hint').textContent = ''; }, 4000);
}
function applyOpt(key, cmd, value) {
  store(key, value);
  renderModel();
  showModelMenu(false);
  const s = active !== null && sessions.get(active);
  if (s && s.info.claude && s.info.alive && !s.info.busy && !s.info.asking) {
    input(s.id, `/${cmd} ${value}`);
    setTimeout(() => input(s.id, '\r'), 60);
    optHint('지금 탭에 적용했어요');
  } else {
    optHint('새 Claude 탭부터 적용돼요');
  }
  focusInput();
}
renderModel();

// Drop images anywhere on the window.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (hasFiles(e) && composeShown()) { dragDepth++; $('#compose').classList.add('drag'); } });
addEventListener('dragleave', () => { if (dragDepth && !--dragDepth) $('#compose').classList.remove('drag'); });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#compose').classList.remove('drag');
  if (!composeShown()) {
    const s = active !== null && sessions.get(active);
    if (!s || !s.info.claude) { toast('이미지는 Claude 탭에 첨부할 수 있어요'); return; }
    setChatPref(true); // attachments live in the conversation's input box
  }
  [...e.dataTransfer.files].forEach(addImage);
  ta.focus();
});

// ---- chat view ----
// Covers the terminal of a Claude tab with the conversation itself, read from the transcript
// Claude Code writes (the server streams it as items). Text wraps to the window like a page.
// A menu Claude shows (permission prompt, question) appears at the bottom as buttons.
const chat = $('#chat');
const chatCol = $('#chat-col');
let chatPref = load('zd-chat') !== '0'; // conversation mode; false = command mode (the raw terminal)
let watching;                            // tab id the server streams to us (null = none)
let shown = { id: null, n: 0 };          // what chatCol holds: tab and item count
let termPeek = null;                     // tab showing its terminal until its menu is answered

let chatUnsupported = false;

function chatShown() {
  const s = active !== null && sessions.get(active);
  // An older desktop app sends no menu contents: its menus still need the terminal.
  const menuNeedsTerm = s && s.info.asking && (!s.info.menu || termPeek === s.id);
  return !!(chatPref && !chatUnsupported && s && s.info.claude && s.info.alive && !menuNeedsTerm);
}

function setChatPref(on) {
  chatPref = on;
  store('zd-chat', on ? '1' : '0');
  syncChat(true);
  focusInput();
}

/** Shows or hides the chat for the active tab and keeps the server's stream on that tab. */
function syncChat(force) {
  const on = chatShown();
  document.body.classList.toggle('chat-on', on);
  document.body.classList.toggle('compose-off', !composeShown());
  growInput(); // chat mode changes the box's font and padding
  // The switch only means something on a Claude tab; a shell is always its terminal.
  const s = active !== null && sessions.get(active);
  $('#mode').hidden = !!s && !s.info.claude;
  for (const b of document.querySelectorAll('#mode button')) b.classList.toggle('on', (b.dataset.mode === 'chat') === chatPref);
  const want = on ? active : null;
  if (want !== watching) {
    watching = want;
    send({ t: 'watch', id: want });
    force = true;
  }
  if (on) renderChat(force);
  else if (active !== null) requestAnimationFrame(() => fitActive());
}

function onChat(m) {
  const s = sessions.get(m.id);
  if (!s) return;
  if (m.reset || !s.chat) s.chat = [];
  s.chat.push(...m.items);
  if (m.id === active && chatShown()) renderChat(m.reset);
}

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline markdown on one line of raw text; everything is escaped first. */
function mdInline(src) {
  const codes = [];
  let s = src.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = escHtml(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escHtml(codes[i])}</code>`);
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => mdInline(c.trim()));

function mdList(items) {
  let out = '';
  const stack = [];
  for (const it of items) {
    while (stack.length > 1 && it.ind < stack[stack.length - 1].ind) out += `</li></${stack.pop().tag}>`;
    const tag = it.ord ? 'ol' : 'ul';
    let top = stack[stack.length - 1];
    if (top && it.ind <= top.ind && top.tag !== tag) { out += `</li></${stack.pop().tag}>`; top = null; } // - then 1.
    if (!top || it.ind > top.ind) {
      stack.push({ ind: it.ind, tag });
      out += `<${tag}><li>`;
    } else out += '</li><li>';
    out += it.text.split('\n').map(mdInline).join('<br>');
  }
  while (stack.length) out += `</li></${stack.pop().tag}>`;
  return out;
}

// ---- code-block colors ----
// A small tokenizer, enough to color code blocks the way the CLI does: comments, strings,
// numbers, keywords, calls and types. Unknown or untagged blocks stay plain (they are mostly
// command output), except diffs, which are recognized by their lines.
const HL_KW = {
  js: 'as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while with yield',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield',
  sh: 'case do done echo elif else esac exit export fi for function if in local return set source then unset until while cd',
  ps: 'begin break catch class continue do else elseif end exit filter finally for foreach function if in param process return switch throw trap try until while',
  c: 'abstract async auto await bool boolean break case catch chan char class const continue default defer delete do double else enum extends extern false final finally float for func go goto if implements import int interface long map namespace new null nullptr override package private protected public range register return select short signed sizeof static string struct super switch template this throw throws true try type typedef typename union unsigned using var virtual void volatile while',
  conf: 'true false null yes no on off',
  sql: 'add all alter and as asc by create delete desc distinct drop from group having in index inner insert into is join key left like limit not null on or order primary references right select set table union update values where',
};
const HL_LANG = {
  js: 'js', javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', cjs: 'js', json: 'js', jsonc: 'js',
  rs: 'rust', rust: 'rust',
  py: 'py', python: 'py',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  ps1: 'ps', powershell: 'ps', pwsh: 'ps',
  c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cs: 'c', csharp: 'c', 'c#': 'c', java: 'c', kotlin: 'c', kt: 'c',
  go: 'c', swift: 'c', dart: 'c', scala: 'c', php: 'c', css: 'c', scss: 'c',
  sql: 'sql', toml: 'conf', yaml: 'conf', yml: 'conf', ini: 'conf', dockerfile: 'sh', makefile: 'sh',
  diff: 'diff', patch: 'diff',
};
const hlCache = {};
function hlRule(kind) {
  if (hlCache[kind]) return hlCache[kind];
  const hash = /^(py|sh|ps|conf)$/.test(kind);
  const com = [hash ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', kind === 'sql' ? '--[^\\n]*' : '', kind === 'ps' ? '<#[\\s\\S]*?#>' : '']
    .filter(Boolean).join('|');
  const str = [kind === 'py' ? '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'' : '', '"(?:\\\\.|[^"\\\\\\n])*"',
    // Rust's 'a lifetimes are not strings: only one-character literals there
    kind === 'rust' ? "'(?:\\\\.|[^'\\\\\\n])'" : "'(?:\\\\.|[^'\\\\\\n])*'", kind === 'js' ? '`(?:\\\\.|[^`\\\\])*`' : '']
    .filter(Boolean).join('|');
  const re = new RegExp(`(?<c>${com})|(?<s>${str})|(?<v>${kind === 'sh' || kind === 'ps' || kind === 'c' ? '\\$\\{?[A-Za-z_][\\w:]*\\}?' : '(?!)'})` +
    `|(?<n>\\b(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)|(?<w>[A-Za-z_][\\w$]*${kind === 'ps' ? '(?:-[A-Za-z]\\w*)?' : '(?:!(?!=))?'})(?<call>\\s*\\()?`, 'g');
  const kw = new Set(HL_KW[kind].split(' '));
  return (hlCache[kind] = { re, kw, ci: kind === 'sql' || kind === 'ps' });
}

/** Code-block text → HTML with `hl-*` spans; everything is escaped. */
function highlight(code, lang) {
  let kind = HL_LANG[(lang || '').toLowerCase()];
  if (!kind && /^(@@ |[+-]{3} )/m.test(code) && /^[+-]/m.test(code)) kind = 'diff';
  if (!kind) return escHtml(code);
  if (kind === 'diff') {
    return code.split('\n').map((l) => {
      const c = /^(\+\+\+|---)( |$)/.test(l) ? 'kw' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l.startsWith('@@') ? 'hunk' : '';
      return c ? `<span class="hl-${c}">${escHtml(l)}</span>` : escHtml(l);
    }).join('\n');
  }
  const { re, kw, ci } = hlRule(kind);
  let out = '', at = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(code))) {
    const g = m.groups;
    let cls = g.c != null ? 'com' : g.s != null ? 'str' : g.v != null ? 'var' : g.n != null ? 'num' : '';
    let tok = m[0];
    if (g.w != null) {
      tok = g.w;
      re.lastIndex = m.index + tok.length; // leave the "(" for the next round
      const w = ci ? tok.toLowerCase() : tok;
      cls = kw.has(w) ? 'kw' : g.call != null || tok.endsWith('!') || tok.includes('-') ? 'fn'
        : /^[A-Z][a-z0-9]/.test(tok) ? 'type' : '';
    }
    out += escHtml(code.slice(at, m.index)) + (cls ? `<span class="hl-${cls}">${escHtml(tok)}</span>` : escHtml(tok));
    at = m.index + tok.length;
  }
  return out + escHtml(code.slice(at));
}

/** Small, safe markdown renderer: headings, lists, code, quotes, tables, rules, paragraphs. */
function md(src) {
  const lines = src.replace(/\r/g, '').split('\n');
  let html = '';
  const para = [];
  const flush = () => { if (para.length) { html += `<p>${para.map(mdInline).join('<br>')}</p>`; para.length = 0; } };
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/))) {
      flush();
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) body.push(lines[i]);
      i++;
      html += `<pre><code>${highlight(body.join('\n'), m[2])}</code></pre>`;
    } else if (!l.trim()) {
      flush(); i++;
    } else if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      flush(); i++;
      html += `<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      flush(); i++;
      html += '<hr>';
    } else if (/^\s*>/.test(l)) {
      flush();
      const body = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*> ?/, ''));
      html += `<blockquote>${md(body.join('\n'))}</blockquote>`;
    } else if (l.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flush();
      let t = `<table><thead><tr>${cells(l).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
        t += `<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join('')}</tr>`;
      }
      html += `<div class="tbl">${t}</tbody></table></div>`;
    } else if (LIST_RE.test(l)) {
      flush();
      const items = [];
      while (i < lines.length) {
        const lm = lines[i].match(LIST_RE);
        if (lm) { items.push({ ind: lm[1].replace(/\t/g, '    ').length, ord: /\d/.test(lm[2]), text: lm[3] }); i++; }
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i])) { items[items.length - 1].text += '\n' + lines[i].trim(); i++; }
        else break;
      }
      html += mdList(items);
    } else {
      para.push(l); i++;
    }
  }
  flush();
  return html;
}

function chatItemEl(it) {
  if (it.k === 'user') return el('div', 'msg user', it.text);
  if (it.k === 'ai') { const d = el('div', 'msg ai'); d.innerHTML = md(it.text); return d; }
  const d = el('div', 'tool');
  d.append(el('span', 'tname', it.name), el('span', 'tdet', it.detail || ''));
  d.title = `${it.name} ${it.detail || ''}`;
  return d;
}

// ---- working indicator ----
// The server sends Claude's live lines as plain text (running tool block + spinner line). They are
// parsed and redrawn here so they move like the CLI: the glyph turns, the verb shimmers, seconds
// tick locally and the token count rolls up, at frame rate instead of the server's update rate.
const SPIN_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
const chatWorking = el('div', 'chat-working');
const wTool = el('div', 'wtool');
const wGlyph = el('span', 'wglyph', '✻');
const wVerb = el('span', 'wverb');
const wMeta = el('span', 'wmeta');
const wSpin = el('div', 'wspin');
wSpin.append(wGlyph, wVerb, wMeta);
chatWorking.append(wTool, wSpin);
const live = { key: null, verb: '', secs: null, at: 0, tokens: null, tokFrom: 0, tokAt: 0, arrow: '', extra: '', frame: -1, raf: 0 };

/** "✻ Symbioting… (1m 3s · ↓ 1.2k tokens · esc to interrupt)" → parts; null if it isn't a spinner line. */
function parseSpinner(line) {
  const m = line.trim().match(/^(\S)\s+(.*?…)\s*(?:\((.*)\))?\s*$/);
  if (!m) return null;
  const r = { verb: m[2], secs: null, tokens: null, arrow: '', extra: [] };
  for (const part of (m[3] || '').split('·').map((p) => p.trim()).filter(Boolean)) {
    const t = part.match(/^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/);
    const k = part.match(/^([↑↓])?\s*([\d.,]+)\s*([kKmM])?\s*tokens?$/);
    if (t) r.secs = (+t[1] || 0) * 3600 + (+t[2] || 0) * 60 + (+t[3] || 0);
    else if (k) { r.arrow = k[1] || ''; r.tokens = parseFloat(k[2].replace(/,/g, '')) * ({ k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[k[3]] || 1); }
    else if (!/esc to interrupt/i.test(part)) r.extra.push(part);
  }
  return r;
}

const fmtSecs = (s) => s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const fmtTokens = (n) => n < 1000 ? `${Math.round(n)}` : `${(n / 1000).toFixed(1)}k`;

/** Token count part way through its roll from the previous value to the latest. */
function liveTokens(now) {
  if (live.tokens == null) return null;
  const p = Math.min(1, (now - live.tokAt) / 700);
  return live.tokFrom + (live.tokens - live.tokFrom) * (1 - (1 - p) ** 3);
}

/** "● Bash(cargo build)" + "⎿  Running…" lines → a card with a blinking dot. */
function renderLiveTool(rows) {
  wTool.replaceChildren();
  wTool.hidden = !rows.length;
  if (!rows.length) return;
  const outAt = rows.findIndex((r, i) => i > 0 && r.trim().startsWith('⎿'));
  const head = rows.slice(0, outAt < 0 ? rows.length : outAt).map((r) => r.trim()).join(' ').replace(/^●\s*/, '');
  const m = head.match(/^([^(]+)\((.*?)\)?$/);
  const h = el('div', 'whead');
  h.append(el('span', 'tdot'), el('span', 'tname', m ? m[1].trim() : head));
  if (m && m[2]) h.append(el('span', 'targs', m[2]));
  h.title = head;
  wTool.append(h);
  if (outAt >= 0) {
    const out = rows.slice(outAt);
    const pad = Math.min(...out.filter((r) => r.trim()).map((r) => r.match(/^ */)[0].length));
    wTool.append(el('pre', 'tout', out.map((r) => r.slice(pad)).join('\n')));
  }
}

/** Takes the active tab's live lines; the animation itself runs in `tickWorking`. */
function updateChatWorking(s) {
  const text = (s && s.info.live) || '';
  tickWorking();
  if (text === live.key) return;
  live.key = text;
  const rows = text ? text.split('\n') : [];
  const spin = rows.length ? parseSpinner(rows[rows.length - 1]) : null;
  renderLiveTool(spin ? rows.slice(0, -1) : []);
  const now = performance.now();
  const verb = spin ? spin.verb : 'Claude가 작업 중이에요…';
  if (verb !== live.verb) {
    live.verb = verb;
    wVerb.textContent = verb;
    wVerb.classList.remove('swap'); void wVerb.offsetWidth; wVerb.classList.add('swap');
  }
  // Seconds count on locally; only jump when the screen disagrees (another tab, or drift).
  if (spin && spin.secs != null) {
    const shown = live.secs == null ? null : live.secs + Math.floor((now - live.at) / 1000);
    if (shown == null || Math.abs(shown - spin.secs) > 1) { live.secs = spin.secs; live.at = now; }
  } else live.secs = null;
  if (spin && spin.tokens != null) {
    live.tokFrom = live.tokens == null ? spin.tokens : liveTokens(now);
    live.tokens = spin.tokens;
    live.tokAt = now;
  } else live.tokens = null;
  live.arrow = spin ? spin.arrow : '';
  live.extra = spin ? spin.extra.join(' · ') : '';
}

/** One animation loop while the indicator is on the page; it stops by itself once removed. */
function tickWorking() {
  if (live.raf) return;
  const step = (now) => {
    if (!chatWorking.isConnected) { live.raf = 0; return; }
    live.raf = requestAnimationFrame(step);
    const f = REDUCED_MOTION.matches ? 4 : Math.floor(now / 110) % SPIN_FRAMES.length;
    if (f !== live.frame) { live.frame = f; wGlyph.textContent = SPIN_FRAMES[f]; }
    const meta = [];
    if (live.secs != null) meta.push(fmtSecs(live.secs + Math.floor((now - live.at) / 1000)));
    if (live.tokens != null) meta.push(`${live.arrow ? live.arrow + ' ' : ''}${fmtTokens(liveTokens(now))} tokens`);
    if (live.extra) meta.push(live.extra);
    const t = meta.length ? `(${meta.join(' · ')})` : '';
    if (wMeta.textContent !== t) wMeta.textContent = t;
  };
  live.raf = requestAnimationFrame(step);
}

/** Brings chatCol up to date with the active tab's items (appends; rebuilds when forced). */
function renderChat(force) {
  const s = sessions.get(active);
  if (!s) return;
  const items = s.chat || [];
  const atBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 60;
  let rebuilt = false;
  if (force || shown.id !== s.id || items.length < shown.n) {
    chatCol.replaceChildren();
    shown = { id: s.id, n: 0 };
    rebuilt = true;
  }
  chatWorking.remove();
  chatMenu.remove();
  chatCol.querySelector('.chat-empty')?.remove();
  // New items slide in; a rebuild or a first load of many items just appears.
  const animate = !rebuilt && items.length - shown.n <= 3;
  for (let i = shown.n; i < items.length; i++) {
    const it = items[i];
    const node = chatItemEl(it);
    if (animate) node.classList.add('enter');
    // Tool calls in a row share one compact block.
    const last = chatCol.lastElementChild;
    if (it.k === 'tool') {
      const box = last && last.classList.contains('tools') ? last : chatCol.appendChild(el('div', 'tools'));
      box.append(node);
    } else chatCol.append(node);
  }
  shown.n = items.length;
  if (!items.length && !s.info.busy && !s.info.menu) chatCol.append(el('div', 'chat-empty', s.chat ? '아래에 메시지를 입력해 대화를 시작하세요' : '불러오는 중…'));
  updateChatWorking(s);
  const menuNew = updateChatMenu(s);
  if (s.info.menu) chatCol.append(chatMenu);
  else if (s.info.busy) chatCol.append(chatWorking);
  if (force || atBottom || menuNew) chat.scrollTop = chat.scrollHeight;
}

// ---- menu card: Claude's numbered menu as buttons ----
const chatMenu = el('div', 'chat-menu');
let menuKey = '';   // what chatMenu shows (tab + menu), to rebuild only on change
let menuSel = 0;    // highlighted option, moved locally by ↑↓ before the server catches up

/** Rebuilds the card when the menu changed; true when a new menu appeared. */
function updateChatMenu(s) {
  const m = s.info.menu;
  if (!m) { chatMenu.remove(); menuKey = ''; return false; }
  const key = JSON.stringify([s.id, m]);
  if (key === menuKey) return false;
  const fresh = !menuKey || JSON.parse(menuKey)[0] !== s.id || JSON.parse(menuKey)[1].title !== m.title;
  menuKey = key;
  menuSel = m.sel;
  const parts = [];
  if (m.title) parts.push(el('div', 'mtitle', m.title));
  const list = el('div', 'mopts');
  m.options.forEach((o, i) => {
    const b = el('button', 'mopt');
    b.type = 'button';
    b.append(el('span', 'mnum', `${o.num ?? i + 1}`), el('span', 'mlabel', o.label));
    if (o.desc) b.append(el('span', 'mdesc', o.desc));
    b.onclick = () => pickMenu(s.id, i);
    list.append(b);
  });
  parts.push(list);
  const foot = el('div', 'mfoot');
  const esc = el('button', 'act ghost', '취소 (Esc)');
  esc.type = 'button';
  esc.onclick = () => { input(s.id, '\x1b'); ta.focus(); };
  const peek = el('button', 'act ghost', '터미널로 보기');
  peek.type = 'button';
  peek.title = '이 메뉴만 터미널에서 직접 골라요. 답하면 대화창으로 돌아와요.';
  peek.onclick = () => { termPeek = s.id; syncChat(true); focusInput(); };
  foot.append(esc, peek, el('span', 'mhint', '↑↓ · Enter로도 고를 수 있어요'));
  parts.push(foot);
  chatMenu.classList.remove('busy');
  chatMenu.replaceChildren(...parts);
  paintMenuSel();
  return fresh;
}

function paintMenuSel() {
  chatMenu.querySelectorAll('.mopt').forEach((b, i) => b.classList.toggle('on', i === menuSel));
}

function moveMenuSel(d) {
  const m = active !== null && sessions.get(active)?.info.menu;
  if (!m || !chatShown()) return;
  menuSel = Math.max(0, Math.min(m.options.length - 1, menuSel + d));
  paintMenuSel();
}

/** Moves Claude's highlight to option `i` with arrow keys, then Enter. */
async function pickMenu(id, i) {
  const s = sessions.get(id);
  if (!s || !s.info.menu || chatMenu.classList.contains('busy')) return;
  chatMenu.classList.add('busy'); // until the server shows the next state
  setTimeout(() => chatMenu.classList.remove('busy'), 3000); // or the pick didn't take
  // From where the highlight is now (↑↓ may have moved it since the server last looked).
  const d = i - menuSel;
  menuSel = i;
  paintMenuSel();
  const app = s.term.modes.applicationCursorKeysMode;
  const key = (app ? '\x1bO' : '\x1b[') + (d < 0 ? 'A' : 'B');
  for (let k = 0; k < Math.abs(d); k++) { input(id, key); await sleep(25); }
  input(id, '\r');
  ta.focus();
}

chat.addEventListener('keydown', (e) => {
  // Ctrl+A selects the conversation only; typing goes to the input box.
  if (e.ctrlKey && !e.shiftKey && e.code === 'KeyA') {
    e.preventDefault();
    getSelection().selectAllChildren(chatCol);
  } else if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key.length === 1 || e.key === 'Process')) {
    ta.focus();
  }
});
for (const b of document.querySelectorAll('#mode button')) b.onclick = () => setChatPref(b.dataset.mode === 'chat');

syncChat(true);

// ---- skills: Claude Code plugins, for the whole account or one project (just me) ----
// The server runs `claude plugin …`; settings live in Claude Code's own files, not here.
const ZERODOC_REPO = 'pqowp90/zerodoc-skills';
let skScope = load('zd-sk-scope') === 'local' ? 'local' : 'user';
let skCwd = load('zd-sk-cwd') || null;
let skData = null;
let skBusy = null; // id (or repo) of the change in flight
let skQTimer = 0;

function skFolders() {
  const out = [];
  const add = (p) => { if (p && !out.some((x) => samePath(x, p))) out.push(p); };
  const cur = active !== null && sessions.get(active);
  if (cur) add(cur.info.cwd);
  for (const p of projects) add(p.path);
  return out;
}

function skRequest() {
  if (!paneOpen('skills')) return;
  send({ t: 'skills', cwd: skScope === 'local' ? skCwd : null, q: $('#sk-q').value });
}

/** The skills pane was just shown (see openSettings). */
function showSkills() {
  if (!projects.length) send({ t: 'projects' });
  // Default to the folder of the conversation in front of us.
  const cur = active !== null && sessions.get(active);
  if (cur && cur.info.cwd) skCwd = cur.info.cwd;
  renderSkillScope();
  skRequest();
}

function renderSkillScope() {
  for (const b of document.querySelectorAll('.sk-scope button')) b.classList.toggle('on', b.dataset.scope === skScope);
  const sel = $('#sk-proj');
  sel.hidden = skScope !== 'local';
  const folders = skFolders();
  if (!skCwd || !folders.some((f) => samePath(f, skCwd))) skCwd = folders[0] || null;
  sel.replaceChildren(...folders.map((f) => {
    const o = el('option', '', f.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || f);
    o.value = f; o.title = f; o.selected = samePath(f, skCwd);
    return o;
  }));
  $('#sk-hint').textContent = skScope === 'user'
    ? '모든 프로젝트에 적용돼요 (~/.claude/settings.json).'
    : skCwd ? `이 프로젝트에서 나에게만 적용돼요 (.claude/settings.local.json · git에 안 올라감).` : '프로젝트 폴더가 없어요. 사이드바에서 ＋로 폴더를 추가하세요.';
}

function skApply(op, id, key = id) {
  if (skBusy) { toast('앞의 작업이 끝나면 다시 눌러 주세요', 2000); return; }
  const scope = skScope === 'local' ? 'local' : 'user';
  if (scope === 'local' && !skCwd && op !== 'market_add') { toast('프로젝트 폴더를 골라 주세요'); return; }
  skBusy = key;
  send({ t: 'skill', op, id, scope, cwd: skCwd });
  renderSkills();
}

function skSwitch(checked, onChange) {
  const w = el('label', 'sw');
  const i = el('input'); i.type = 'checkbox'; i.checked = checked;
  i.onchange = () => onChange(i.checked);
  w.append(i, el('span'));
  return w;
}

function skRow(name, market, desc) {
  const row = el('div', 'sk-row');
  const main = el('div', 'sk-main');
  const title = el('div', 'sk-name', name);
  title.append(el('span', 'sk-mk', market));
  main.append(title);
  if (desc) { const d = el('div', 'sk-desc', desc); d.title = desc; main.append(d); }
  row.append(main);
  return { row, main };
}

function renderSkills() {
  const m = skData;
  if (!m) return;
  const local = skScope === 'local';

  const card = $('#sk-market');
  card.replaceChildren();
  if (!m.zerodoc) {
    const c = el('div', 'sk-card');
    c.append(el('span', '', 'zerodoc 기본 스킬 저장소를 연결하면 화면 캡처 같은 스킬을 바로 켤 수 있어요.'));
    const b = el('button', 'act', skBusy === ZERODOC_REPO ? '연결 중…' : '연결');
    b.disabled = !!skBusy;
    b.onclick = () => skApply('market_add', ZERODOC_REPO);
    c.append(b);
    card.append(c);
  }

  const list = $('#sk-list');
  if (!m.items.length) list.replaceChildren(el('div', 'side-empty', '설치된 스킬이 없어요. 아래에서 찾아 켜 보세요.'));
  else list.replaceChildren(...m.items.map((it) => {
    const { row, main } = skRow(it.name, it.market, it.description);
    if (skBusy === it.id) row.classList.add('busy');
    const on = local ? it.on : it.user === true;
    const note = el('div', 'sk-note');
    if (local) {
      if (it.local !== null) {
        note.append(el('span', '', it.local ? '이 프로젝트에서 켬' : '이 프로젝트에서 끔'));
        const r = el('button', '', '↺ 계정 설정 따르기');
        r.title = `계정 공통: ${it.user ? '켬' : '끔'}`;
        r.onclick = () => skApply('reset', it.id);
        note.append(r);
      } else if (it.project !== null) note.append(el('span', '', `팀 설정(.claude/settings.json): ${it.project ? '켬' : '끔'}`));
      else note.append(el('span', '', it.user ? '계정 공통으로 켜짐' : '계정 공통에선 꺼져 있음'));
    } else {
      if (it.scopes.includes('user')) {
        const del = el('button', '', '삭제');
        del.onclick = () => { if (confirm(`${it.name} 스킬을 계정에서 삭제할까요?`)) skApply('uninstall', it.id); };
        note.append(del);
      } else if (it.scopes.length) note.append(el('span', '', '일부 프로젝트에만 설치됨'));
    }
    if (note.childElementCount) main.append(note);
    row.append(skSwitch(on, (v) => skApply(v ? 'on' : 'off', it.id)));
    return row;
  }));

  const res = $('#sk-results');
  const q = $('#sk-q').value.trim();
  $('#sk-q').placeholder = `이름·설명으로 검색 (${m.total.toLocaleString()}개)`;
  const rows = m.results.map((r) => {
    const { row } = skRow(r.name, r.market, r.description);
    if (skBusy === r.id) row.classList.add('busy');
    const b = el('button', 'act', skBusy === r.id ? '설치 중…' : local ? '이 프로젝트에 추가' : '추가');
    b.onclick = () => skApply('on', r.id);
    row.append(b);
    return row;
  });
  if (m.found > m.results.length) rows.push(el('div', 'side-empty', `${m.found - m.results.length}개 더 있어요 · 검색어를 더 적어 보세요`));
  if (!rows.length) rows.push(el('div', 'side-empty', q ? '찾는 스킬이 없어요' : '추가할 수 있는 스킬이 없어요'));
  res.replaceChildren(...rows);
}

function onSkills(m) {
  // Drop answers for a folder/scope we have since left.
  const want = skScope === 'local' ? skCwd : null;
  const got = m.cwd || null;
  if (want === null ? got !== null : !(got && samePath(got, want))) return;
  skData = m;
  renderSkills();
}

function onSkillDone(m) {
  skBusy = null;
  if (m.error) toast(m.error, 7000);
  else toast(`✓ ${m.msg} · 새로 여는 Claude 대화부터 적용돼요`, 4000);
  renderSkills();
  skRequest();
}

for (const b of document.querySelectorAll('.sk-scope button')) {
  b.onclick = () => {
    skScope = b.dataset.scope; store('zd-sk-scope', skScope);
    skData = null; $('#sk-list').replaceChildren(el('div', 'side-empty', '불러오는 중…'));
    renderSkillScope(); skRequest();
  };
}
$('#sk-proj').onchange = (e) => { skCwd = e.target.value; store('zd-sk-cwd', skCwd); renderSkillScope(); skRequest(); };
$('#sk-q').oninput = () => { clearTimeout(skQTimer); skQTimer = setTimeout(skRequest, 250); };
$('#sk-add').onsubmit = (e) => {
  e.preventDefault();
  const repo = $('#sk-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast('GitHub 저장소를 owner/repo 형식으로 적어 주세요'); return; }
  skApply('market_add', repo);
  $('#sk-repo').value = '';
};

// ---- chrome ----
$('#new-claude').onclick = () => newTab(true);
$('#new-shell').onclick = () => newTab(false);
$('#pair-btn').onclick = () => send({ t: 'pair' });
$('#remote-on').onchange = (e) => send({ t: 'remote', on: e.target.checked });

const KEYS = { esc: '\x1b', tab: '\t', stab: '\x1b[Z', ctrlc: '\x03', nl: '\x1b\r', enter: '\r' };
for (const b of document.querySelectorAll('#keys button')) {
  b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the soft keyboard open
  b.addEventListener('click', () => {
    if (active === null) return;
    const k = b.dataset.k;
    // With the input box shown, Enter/newline act on the box when it has content.
    if (composeShown() && k === 'enter' && (ta.value || atts.length)) { sendCompose(); return; }
    if (composeShown() && k === 'nl' && document.activeElement === ta) { ta.setRangeText('\n', ta.selectionStart, ta.selectionEnd, 'end'); growInput(); return; }
    const appCursor = sessions.get(active).term.modes.applicationCursorKeysMode;
    const arrow = { up: 'A', down: 'B' }[k];
    input(active, arrow ? (appCursor ? '\x1bO' : '\x1b[') + arrow : KEYS[k]);
  });
}

new ResizeObserver(() => { if (active !== null) fitActive(); }).observe($('#terms'));
(async () => {
  if (p2pMode) await pairFromHash();
  connect();
})();
