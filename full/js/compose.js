// DeskDoc web client: the input box: drafts, attachments, quotes, completions.
'use strict';

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
// Unsent text outlives the page and the tab: a phone browser drops the page when you switch
// apps, the desktop window reloads after an update, and a conversation closed and later opened
// again from the sidebar gets back what was being typed. Kept per Claude conversation when known
// (transcript id), else per tab (id + start time, since ids repeat after the desktop restarts).
const DRAFT_KEEP_MS = 30 * 864e5;
/** @type {Record<string, {text:string, at:number}>} */
let savedDrafts = {};
try { savedDrafts = JSON.parse(load('zd-drafts') || '{}') || {}; } catch {}
let draftsReady = false; // only after the first tab list: before it, a save would drop them
let draftTimer = 0;
function draftKey(s) {
  const conv = s.conv || s.info.resume
    || projects.flatMap((p) => p.sessions).find((c) => c.tab === s.id)?.id;
  return conv ? `c:${conv}` : `t:${s.id}:${s.info.started}`;
}
/** Tabs that just learned their conversation (or just appeared) take back its saved text. */
function adoptDrafts() {
  for (const s of sessions.values()) {
    const key = draftKey(s);
    if (key === s.draftKey) continue;
    if (s.draftKey) delete savedDrafts[s.draftKey]; // what it had moves to the new key on save
    s.draftKey = key;
    const saved = savedDrafts[key]?.text;
    if (!saved || (s.id === draftOf ? ta.value : drafts.get(s.id))) continue;
    drafts.set(s.id, saved);
    if (s.id === draftOf) { ta.value = saved; growInput(); }
  }
}
function saveDrafts() {
  clearTimeout(draftTimer);
  if (!draftsReady) return;
  adoptDrafts();
  if (draftOf !== null) drafts.set(draftOf, ta.value);
  const open = new Set();
  for (const s of sessions.values()) {
    open.add(s.draftKey);
    const text = drafts.get(s.id);
    if (!text) delete savedDrafts[s.draftKey];
    else if (savedDrafts[s.draftKey]?.text !== text) savedDrafts[s.draftKey] = { text, at: Date.now() };
  }
  // A closed tab's text stays only if its conversation can be opened again, and not forever.
  for (const [k, v] of Object.entries(savedDrafts)) {
    if (!open.has(k) && (k.startsWith('t:') || !(Date.now() - v?.at < DRAFT_KEEP_MS))) delete savedDrafts[k];
  }
  store('zd-drafts', Object.keys(savedDrafts).length ? JSON.stringify(savedDrafts) : undefined);
}
const saveDraftsSoon = () => { clearTimeout(draftTimer); draftTimer = setTimeout(saveDrafts, 400); };
addEventListener('pagehide', saveDrafts);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveDrafts(); });
/** @type {{uid:string, url:string, path:string|null}[]} */
let atts = [];
/** Text quoted from the conversation: chips above the box, sent as "> …" ahead of the text. */
let quotes = [];
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
  acClose();
  if (draftOf !== null) drafts.set(draftOf, ta.value);
  draftOf = id;
  ta.value = drafts.get(id) || '';
  growInput();
}

function growInput() {
  saveDraftsSoon(); // every change to the box's text comes through here
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

function renderQuotes() {
  updateSend();
  $('#quote-list').replaceChildren(...quotes.map((q) => {
    const box = el('div', 'qchip');
    box.title = q;
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.title = '인용 빼기';
    x.onclick = () => { quotes = quotes.filter((o) => o !== q); renderQuotes(); focusInput(); };
    box.append(el('span', 'qmark', '❝'), el('span', 'qt', q.replace(/\s+/g, ' ')), x);
    return box;
  }));
}

/** What the box sends: the quotes as Markdown block quotes, then the typed text. */
function composeText() {
  const text = ta.value.replace(/\r\n/g, '\n');
  if (!quotes.length) return text;
  const q = quotes.map((t) => t.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n')).join('\n\n');
  return text.trim() ? `${q}\n\n${text}` : q;
}

function clearQuotes() {
  quotes = [];
  renderQuotes();
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
  acClose();
  const s = sessions.get(active);
  const text = composeText();
  if (atts.some((a) => !a.path)) { sendWhenUploaded = true; toast('이미지를 다 올리면 보낼게요', 2000); return; }
  if (!text && !atts.length) { input(s.id, '\r'); return; } // empty Enter: confirm menus etc.
  // Claude is still starting: keys typed now can be lost, so hold it until its prompt is up.
  if (notReady(s)) { holdCompose(); return; }
  // A menu is waiting: typed into it, the message would be lost (or pick something). Hold it
  // until the menu is answered. A question with a free-text option takes the typing, so not there.
  const m = s.info.claude && s.info.menu;
  if (m && !m.options.some((o) => /^type something/i.test(o.label))) {
    holdCompose();
    toast('메뉴에 먼저 답해 주세요. 답하면 이 메시지를 보낼게요', 3000);
    return;
  }
  const sent = atts;
  atts = [];
  ta.value = '';
  drafts.delete(s.id);
  clearQuotes();
  growInput();
  renderAtts();
  await deliver(s, text, sent);
}

/** Types a message into a tab: image paths, the text, then Enter. */
async function deliver(s, text, sent) {
  s.sentAt = Date.now();
  addPending(s, text, sent.length);
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
  const empty = !ta.value && !atts.length && !quotes.length;
  if (e.key === 'Escape') return '\x1b';
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) return e.shiftKey ? '\x1b[Z' : '\t';
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC' && ta.selectionStart === ta.selectionEnd) return '\x03';
  if (empty && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    moveMenuSel(e.key === 'ArrowUp' ? -1 : 1);
    return arrowKey(sessions.get(active), e.key === 'ArrowUp' ? 'A' : 'B');
  }
  // ←/→ change a value in a settings-style menu.
  if (empty && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const s = sessions.get(active);
    if (s?.info.menu) return arrowKey(s, e.key === 'ArrowLeft' ? 'D' : 'C');
  }
  return null;
}

// ---- completions, like Claude Code's prompt ----
// `/` at the start lists slash commands, `@` lists files and folders in the tab's folder. The
// desktop builds the list (complete.rs); this only shows it and puts the pick in the box.
const acList = $('#ac-list');
/** @type {null | {word:string, items:{insert:string, label:string, desc:string, kind:string}[], sel:number}} */
let ac = null;
let acRid = 0;
let acTimer = 0;
let acOff = false; // an older desktop app without completions
function acRequest() {
  clearTimeout(acTimer);
  const before = ta.value.slice(0, ta.selectionStart);
  // Ask only while a `/…` or `@…` word is at the cursor.
  if (acOff || active === null || !composeShown() || ta.selectionStart !== ta.selectionEnd
    || !/(^\s*\/\S*|(^|\s)@\S*)$/.test(before)) { acClose(); return; }
  // A new rid right away: an answer still on the way is for older text and is dropped.
  const id = active;
  const rid = String(++acRid);
  acTimer = setTimeout(() => send({ t: 'complete', rid, id, before }), 50);
}
function acClose() {
  clearTimeout(acTimer);
  acRid++; // answers still on the way are dropped
  ac = null;
  acList.hidden = true;
  acList.replaceChildren();
}
function onComplete(m) {
  if (m.rid !== String(acRid)) return;
  if (m.error || !m.items?.length) { acClose(); return; }
  ac = { word: m.word, items: m.items, sel: 0 };
  acRender();
}
function acRender() {
  acList.replaceChildren(...ac.items.map((it, i) => {
    const row = el('div', 'ac-i' + (i === ac.sel ? ' sel' : ''));
    row.append(el('span', 'ac-l ' + it.kind, it.label));
    if (it.kind === 'skill') row.append(el('span', 'ac-k', '스킬'));
    if (it.desc) row.append(el('span', 'ac-d', it.desc));
    row.title = it.desc ? `${it.label}\n${it.desc}` : it.label;
    row.onmousemove = () => { if (ac && ac.sel !== i) { ac.sel = i; acRender(); } };
    row.onclick = () => acAccept(i, false);
    return row;
  }));
  acList.hidden = false;
  acList.children[ac.sel]?.scrollIntoView({ block: 'nearest' });
}
/** Puts item `i` in place of the word at the cursor; `run` sends it right away (Enter on a command). */
function acAccept(i, run) {
  const it = ac?.items[i];
  const pos = ta.selectionStart;
  const start = pos - (ac?.word.length ?? 0);
  if (!it || ta.value.slice(start, pos) !== ac.word) { acClose(); return; }
  ta.value = ta.value.slice(0, start) + it.insert + ta.value.slice(pos);
  ta.setSelectionRange(start + it.insert.length, start + it.insert.length);
  acClose();
  if (run) { ta.value = ta.value.trimEnd(); growInput(); sendCompose(); return; }
  growInput();
  ta.focus();
  acRequest(); // a folder: what is inside it next
}
/** Keys the open list takes: ↑↓ move, Tab/Enter pick, Esc closes. */
function acKey(e) {
  if (!ac || e.ctrlKey || e.altKey || e.metaKey) return false;
  // The list is for text typed before (its update is on the way): the key does what it usually does.
  if (!ta.value.slice(0, ta.selectionStart).endsWith(ac.word)) { acClose(); return false; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const n = ac.items.length;
    ac.sel = (ac.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    acRender();
  } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
    const kind = ac.items[ac.sel].kind;
    acAccept(ac.sel, e.key === 'Enter' && !touch && (kind === 'command' || kind === 'skill'));
  } else if (e.key === 'Escape') acClose();
  else return false;
  e.preventDefault();
  return true;
}
acList.addEventListener('mousedown', (e) => e.preventDefault()); // keep the box focused
ta.addEventListener('input', acRequest);
ta.addEventListener('click', acRequest);
ta.addEventListener('keyup', (e) => { if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) acRequest(); });
ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) acClose(); }, 0));

ta.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME is composing (Korean etc.)
  if (active === null) return;
  if (acKey(e)) return;
  // Tab in an empty box takes Claude Code's suggested next message, like its own prompt.
  if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !ta.value && !atts.length && !quotes.length && takeSuggest()) {
    e.preventDefault();
    return;
  }
  // Backspace at the very start of the box takes off the last quote chip, whole.
  if (e.key === 'Backspace' && quotes.length && ta.selectionStart === 0 && ta.selectionEnd === 0) {
    e.preventDefault();
    quotes.pop();
    renderQuotes();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !touch) {
    e.preventDefault();
    sendCompose();
    return;
  }
  // Ctrl+Enter: send once Claude is done (held like the "끝나면 전송" button).
  if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    holdCompose();
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
