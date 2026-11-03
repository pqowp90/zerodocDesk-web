// DeskDoc web client — the same page runs in the desktop window and on remote devices.
// Split into files under js/, loaded in order by index.html; this one holds the shared state,
// theme, clipboard and terminal tabs.
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
const nav = { back: [], fwd: [] }; // tabs shown before/after this one (mouse back/forward), most recent last
let navStepping = false;           // activate() called by navStep: don't record it
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
    // Same as --sb / --sb-hover in style.css.
    scrollbarSliderBackground: 'rgba(255,255,255,.14)', scrollbarSliderHoverBackground: 'rgba(255,255,255,.26)',
    scrollbarSliderActiveBackground: 'rgba(255,255,255,.34)',
  },
  light: {
    background: '#ffffff', foreground: '#1f2329', cursor: '#c96442', cursorAccent: '#ffffff',
    selectionBackground: '#c9d7f2',
    black: '#1f2329', red: '#c9372c', green: '#2f8a3e', yellow: '#9a6a00', blue: '#2f6fe0',
    magenta: '#a3329e', cyan: '#0f7c8c', white: '#8b919c',
    brightBlack: '#646b78', brightRed: '#e0483c', brightGreen: '#3a9e4a', brightYellow: '#b07d0a',
    brightBlue: '#4a84ea', brightMagenta: '#b84bb3', brightCyan: '#1690a2', brightWhite: '#b4bac4',
    scrollbarSliderBackground: 'rgba(0,0,0,.18)', scrollbarSliderHoverBackground: 'rgba(0,0,0,.32)',
    scrollbarSliderActiveBackground: 'rgba(0,0,0,.42)',
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
  syncThemeColor();
  renderThemePane();
}
/** Phone status bar / installed app title bar follow the top bar's color. */
function syncThemeColor() {
  const c = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim();
  if (c) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c);
}
syncThemeColor();
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
  // The replay is drawn at the PTY's width: lay it out at that size, not xterm's default 80x24.
  if (info.cols && info.rows) term.resize(info.cols, info.rows);
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
  saveDrafts(); // keep what was typed for when its conversation is opened again
  s.term.dispose(); s.el.remove(); sessions.delete(id);
  drafts.delete(id);
  queued.delete(id);
  if (draftOf === id) draftOf = null;
  if (active === id) active = null;
}

function activate(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (!navStepping && active !== null && active !== id) {
    nav.back.push(active);
    if (nav.back.length > 50) nav.back.shift();
    nav.fwd.length = 0;
  }
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
  renderAgents();
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
