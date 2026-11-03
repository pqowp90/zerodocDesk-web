// DeskDoc web client: under the input box: send / stop, queue, suggested next message, model and mode pickers.
'use strict';

// ---- send / stop buttons ----
// Idle: → sends. Claude working, box empty: ■ stops it (Esc). Claude working and something typed:
// "바로 전송" (= Enter; Claude Code takes it in mid-turn) or "끝나면 전송" (held here, sent once it's done).
/** A Claude tab that hasn't drawn its prompt yet (an older desktop app sends no `ready`). */
const notReady = (s) => s.info.claude && s.info.alive && s.info.ready === false;
function workingTab() {
  const s = active !== null && sessions.get(active);
  return s && s.info.claude && s.info.alive && s.info.busy ? s : null;
}
function updateSend() {
  const busy = !!workingTab();
  const has = !!(ta.value.trim() || atts.length || quotes.length);
  $('#send-btn').hidden = busy;
  $('#send-btn').classList.toggle('idle', !has);
  $('#stop-btn').hidden = !busy || has;
  $('#now-btn').hidden = !busy || !has;
  $('#queue-btn').hidden = !busy || !has;
  renderQueue();
  renderSuggest(has);
  renderMode();
  renderCtxMenu();
}

// ---- suggested next message ----
// After a reply Claude Code puts a suggestion in its empty input box in dim text (Tab takes it).
// The desktop reads it off the screen (`suggest`); here it shows in the empty box the same way,
// and Tab (or tapping the chip on a phone) puts it in the box to edit or send.
function curSuggest() {
  const s = active !== null && sessions.get(active);
  return s && s.info.claude && !s.info.busy && !s.info.menu ? s.info.suggest || '' : '';
}
function renderSuggest(has) {
  const sug = curSuggest();
  ta.placeholder = sug || '메시지 입력'; // no key hint: Claude Code shows the bare suggestion too
  ta.classList.toggle('suggest', !!sug);
  const chip = $('#suggest-chip');
  chip.hidden = !touch || !sug || has;
  chip.textContent = sug;
}
function takeSuggest() {
  const sug = curSuggest();
  if (!sug) return false;
  ta.value = sug;
  ta.setSelectionRange(sug.length, sug.length);
  growInput();
  ta.focus();
  return true;
}
$('#suggest-chip').onclick = takeSuggest;
function renderQueue() {
  const list = (active !== null && queued.get(active)) || [];
  const s = active !== null && sessions.get(active);
  const label = s && notReady(s) ? '준비되면 전송' : s && s.info.asking && !s.info.busy ? '답하면 전송' : '끝나면 전송';
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
    row.append(label, el('span', '', (q.atts.length ? `🖼${q.atts.length} ` : '') + q.text.replace(/\s+/g, ' ')), x);
    return row;
  }));
}
/** Holds the box until the active Claude tab is done (button, or Ctrl+Enter). Sends right away
 *  only when the tab is idle, nothing is held ahead of it, and nothing was just sent (busy may
 *  not show yet, and sending then would cut into the turn that is starting). */
function holdCompose() {
  const s = active !== null && sessions.get(active);
  if (!s) return;
  acClose();
  const text = composeText();
  if (!text.trim() && !atts.length) return;
  const wait = s.info.claude && s.info.alive && (s.info.busy || s.info.asking || notReady(s)
    || queued.get(s.id)?.length || Date.now() - (s.sentAt || 0) < 3000);
  if (!wait) { sendCompose(); return; }
  if (atts.some((a) => !a.path)) { toast('이미지를 다 올린 뒤에 눌러 주세요', 2000); return; }
  if (!queued.has(s.id)) queued.set(s.id, []);
  queued.get(s.id).push({ text, atts });
  atts = [];
  ta.value = '';
  drafts.delete(s.id);
  clearQuotes();
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
    if (s.info.busy || s.info.asking || notReady(s) || Date.now() - (s.sentAt || 0) < 3000) continue;
    const q = list.shift();
    deliver(s, q.text, q.atts);
  }
  renderQueue();
  dropStalePending();
}

// ---- sent, not yet in the transcript ----
// The chat is drawn from Claude Code's transcript, which records a message only once Claude takes
// it in (a mid-turn one at the next step). Until then it shows here as a faint "보내는 중" bubble.
// Each new user item in the transcript confirms the oldest pending one.
const userCount = (s) => (s.chat || []).reduce((n, it) => n + (it.k === 'user'), 0);
function addPending(s, text, images) {
  // Slash commands and menu answers never become a user message in the transcript.
  // Only while the transcript is loaded: the count needs a starting point.
  if (!s.info.claude || !s.chat || s.info.menu || text.trim().startsWith('/')) return;
  if (!s.pending?.length) { s.pending = []; s.pendBase = userCount(s); }
  s.pending.push({ text: text.trim(), images, at: Date.now() });
  if (s.id === active && chatShown()) renderChat();
}
function confirmPending(s) {
  if (!s.pending?.length) return;
  const n = userCount(s);
  if (n < s.pendBase) s.pendBase = n; // a new conversation (/clear): count from there
  while (s.pending.length && n > s.pendBase) { s.pending.shift(); s.pendBase++; }
}
/** Drops pending messages of a tab that has sat idle for a while after they were sent (they never
 *  took). Counted from when it went idle, so a mid-turn message isn't dropped as the turn ends. */
function dropStalePending() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (!s.pending?.length) continue;
    if (s.info.busy || s.info.asking) { s.idleAt = 0; continue; }
    s.idleAt ||= now;
    const since = Math.max(s.idleAt, s.pending[s.pending.length - 1].at);
    if (now - since < 8000) continue;
    s.pending = [];
    if (s.id === active && chatShown()) renderChat();
  }
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
// Menu icons are inline SVG like the send button: text glyphs (⌃ ✓) sit off-center and change per font.
function svgIcon(d, size) {
  return '<svg viewBox="0 0 16 16" width="' + (size || 14) + '" height="' + (size || 14) + '" aria-hidden="true" fill="none"'
    + ' stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';
}
function checkMark(on) {
  const c = el('span', 'ck');
  if (on) c.innerHTML = svgIcon('M3.5 8.5l3 3 6-7', 14);
  return c;
}
// Thinking level as 1–5 rising bars, the lit ones in the text color.
function effortBars(level) {
  let r = '';
  for (let i = 0; i < 5; i++) {
    const h = 4 + i * 2.75;
    r += '<rect x="' + (0.5 + i * 3.1) + '" y="' + (15 - h) + '" width="2.2" height="' + h + '" rx="1" fill="currentColor"'
      + (i < level ? '' : ' opacity=".2"') + '/>';
  }
  return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' + r + '</svg>';
}
const modelMenu = $('#model-menu');
function renderModel() {
  const m = curModel(), e = curEffort();
  $('#model-name').textContent = MODELS.find((x) => x[0] === m)[1];
  $('#model-eff').textContent = EFFORTS.find((x) => x[0] === e)[1];
  const item = (list, cur, pick, icon) => list.map(([v, label, note], i) => {
    const b = el('button', 'mm-i');
    b.type = 'button';
    const l = el('span', 'mm-t', label);
    if (note) l.append(' ', el('small', '', note));
    if (icon) {
      const ic = el('span', 'mico');
      ic.innerHTML = icon(i);
      b.append(ic);
    }
    b.append(l, checkMark(v === cur));
    b.onclick = () => pick(v);
    return b;
  });
  $('#mm-models').replaceChildren(...item(MODELS, m, (v) => applyOpt('zd-model', 'model', v)));
  $('#mm-efforts').replaceChildren(...item(EFFORTS, e, (v) => applyOpt('zd-effort', 'effort', v), (i) => effortBars(i + 1)));
}
function showModelMenu(on) {
  modelMenu.hidden = !on;
  $('#model-btn').classList.toggle('open', on);
}
$('#model-btn').onclick = () => showModelMenu(modelMenu.hidden);
document.addEventListener('pointerdown', (e) => { if (!modelMenu.hidden && !isNavButton(e) && !e.target.closest('#model-btn, #model-menu')) showModelMenu(false); });
modelMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); showModelMenu(false); focusInput(); } });

// ---- permission mode picker (in the input box, left of send) ----
// Claude Code's own modes (Shift+Tab in its terminal). The desktop reads the active tab's mode off
// its screen (`mode`, `modes`) and switches by pressing Shift+Tab until it shows (`{t:"mode"}`).
// An older desktop app sends no `mode`: the picker stays hidden.
// [label, note, icon path]
var MODES = {
  default: ['Default', '편집·명령 전에 물어봐요', 'M8 1.8l5 1.8v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4z'],
  acceptEdits: ['Accept edits', '파일 편집은 묻지 않아요', 'M10.8 2.7l2.5 2.5L6 12.5l-3.2.7.7-3.2zM9.3 4.2l2.5 2.5'],
  plan: ['Plan', '읽기만 하고 계획부터 세워요', 'M6 4.5h7M6 8h7M6 11.5h7M3 4.5h.01M3 8h.01M3 11.5h.01'],
  auto: ['Auto', '안전한 작업은 알아서 해요', 'M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z'],
  bypassPermissions: ['Bypass', '아무것도 묻지 않아요', 'M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5h.01'],
};
var MODE_ICON_OTHER = 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z';
// `var`: updateSend() may run renderMode() before this part of the file has run.
var modeWait = null; // {id, mode, timer} while a switch runs
var modeKey = '';
function modeMenu() { return $('#mode-menu'); }
function renderMode() {
  const s = active !== null && sessions.get(active);
  const mode = s && s.info.claude && s.info.alive ? s.info.mode : null;
  $('#mode-pick').hidden = !mode;
  if (!mode) { showModeMenu(false); return; }
  const pending = modeWait && modeWait.id === s.id ? modeWait.mode : null;
  const shown = pending || mode;
  $('#mode-name').textContent = (MODES[shown] || [shown])[0];
  $('#mode-ico').innerHTML = svgIcon((MODES[shown] || [])[2] || MODE_ICON_OTHER);
  $('#mode-btn').dataset.mode = shown;
  $('#mode-btn').classList.toggle('wait', !!pending);
  const list = s.info.modes || ['default', 'acceptEdits', 'plan', 'auto'];
  // Rebuilt only when it changes, so a session update doesn't swap a button out from under a click.
  const key = JSON.stringify([mode, list]);
  if (key === modeKey) return;
  modeKey = key;
  modeMenu().replaceChildren(el('div', 'mm-h', '권한 모드 · Shift+Tab'), ...list.map((v) => {
    const [label, note, icon] = MODES[v] || [v, ''];
    const b = el('button', 'mm-i');
    b.type = 'button';
    b.dataset.mode = v;
    const ic = el('span', 'mico');
    ic.innerHTML = svgIcon(icon || MODE_ICON_OTHER);
    const l = el('span', 'mm-l', label);
    if (note) l.append(el('small', '', note));
    b.append(ic, l, checkMark(v === mode));
    b.onclick = () => pickMode(v);
    return b;
  }));
}
function showModeMenu(on) {
  modeMenu().hidden = !on;
  $('#mode-btn').classList.toggle('open', on);
}
function pickMode(v) {
  showModeMenu(false);
  const s = active !== null && sessions.get(active);
  if (s && v !== s.info.mode && !modeWait) {
    // No answer (connection dropped): stop waiting after a while.
    modeWait = { id: s.id, mode: v, timer: setTimeout(() => onModeDone({}), 15000) };
    send({ t: 'mode', id: s.id, mode: v });
    renderMode();
  }
  focusInput();
}
function onModeDone(m) {
  if (modeWait) clearTimeout(modeWait.timer);
  modeWait = null;
  if (m.error) toast(m.error, 5000);
  renderMode();
}
$('#mode-btn').onclick = () => { if (!modeWait) showModeMenu(modeMenu().hidden); };
document.addEventListener('pointerdown', (e) => { if (!modeMenu().hidden && !isNavButton(e) && !e.target.closest('#mode-pick')) showModeMenu(false); });
modeMenu().addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); showModeMenu(false); focusInput(); } });

// ---- context ring: click = how full, and "summarize now" (/compact) ----
// `var`: updateSend() may run renderCtxMenu() before this part of the file has run.
var compactWait = null; // {id, timer} while a /compact request runs
function ctxMenu() { return $('#ctx-menu'); }
function renderCtxMenu() {
  const menu = ctxMenu();
  if (!menu) return;
  const s = active !== null && sessions.get(active);
  const ctx = s && s.info.claude && s.ctx;
  if (!ctx || $('#ctx-pick').hidden) { if (!menu.hidden) showCtxMenu(false); return; }
  const cp = pctOf((ctx.used / ctx.max) * 100);
  // A bar and the percent: token counts in two units ("89.5k / 1M") read badly. Exact numbers on hover.
  const info = $('#ctx-info'), bar = el('i');
  bar.style.setProperty('--p', cp + '%');
  info.className = warnClass(cp).trim();
  info.title = `${ctxTokens(ctx.used, ctx.max)} 토큰`;
  info.replaceChildren(bar, el('span', '', cp + '%'));
  // Same rules as the desktop app's (api::compact), only to explain the greyed-out button.
  const why = compactWait && compactWait.id === s.id ? '요약을 부탁하는 중…'
    : !s.info.alive ? '탭이 실행 중이 아니에요'
    : s.info.asking ? 'Claude가 선택을 기다리는 중이에요. 먼저 답해 주세요'
    : s.info.busy ? 'Claude가 작업 중이에요. 끝난 뒤에 요약할 수 있어요'
    : '';
  $('#compact-btn').disabled = !!why;
  $('#compact-why').hidden = !why;
  $('#compact-why').textContent = why;
}
function showCtxMenu(on) {
  ctxMenu().hidden = !on;
  $('#chat-ctx').classList.toggle('open', on);
  if (on) renderCtxMenu();
}
function compactNow() {
  const s = active !== null && sessions.get(active);
  if (!s || compactWait) return;
  // No answer (connection dropped): stop waiting after a while.
  compactWait = { id: s.id, timer: setTimeout(() => onCompactDone({}), 15000) };
  send({ t: 'compact', id: s.id });
  renderCtxMenu();
}
function onCompactDone(m) {
  if (compactWait) clearTimeout(compactWait.timer);
  const ok = compactWait && m.t === 'compact_done' && !m.error;
  compactWait = null;
  if (m.error) toast(m.error, 5000);
  if (ok) { showCtxMenu(false); toast('대화를 요약하고 있어요'); focusInput(); }
  else renderCtxMenu();
}
$('#chat-ctx').onclick = () => showCtxMenu(ctxMenu().hidden);
$('#compact-btn').onclick = compactNow;
document.addEventListener('pointerdown', (e) => { if (!ctxMenu().hidden && !isNavButton(e) && !e.target.closest('#ctx-pick')) showCtxMenu(false); });
ctxMenu().addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); showCtxMenu(false); focusInput(); } });
