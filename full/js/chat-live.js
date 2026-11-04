// DeskDoc web client: the conversation while Claude works: working indicator, pinned question, menu card, quote.
'use strict';

// ---- working indicator ----
// The server sends Claude's live lines as plain text (running tool block + spinner line). They are
// parsed and redrawn here so they move like the CLI: the glyph turns, the verb shimmers, seconds
// tick locally and the token count rolls up, at frame rate instead of the server's update rate.
const SPIN_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
const chatWorking = el('div', 'chat-working');
// What Claude said before the command it is running, until the transcript has it (server's `note`).
const chatNote = el('div', 'msg ai note');
let noteKey = null;
const wTool = el('div', 'wtool');
const wGlyph = el('span', 'wglyph', '✻');
const wVerb = el('span', 'wverb');
const wMeta = el('span', 'wmeta');
const wSpin = el('div', 'wspin');
wSpin.append(wGlyph, wVerb, wMeta);
chatWorking.append(wTool, wSpin);
const live = { key: null, verb: '', secs: null, at: 0, tokens: null, tokFrom: 0, tokAt: 0, arrow: '', extra: '', frame: -1, raf: 0 };

// ---- background work left running after the turn (subagents, shells, monitors) ----
// Claude is idle but they still go on: a quiet line under the last reply, like the CLI's footer.
const chatBg = el('div', 'chat-bg');
const chatBgText = el('span');
chatBg.append(el('span', 'bg-ring'), chatBgText);
/** "에이전트 1개 · 모니터 1개 · 셸 2개 실행 중" from the server's counts (`jobs`); generic when it sent none. */
function bgText(info) {
  const j = info.jobs || {};
  const parts = [['agent', 'bg.agent'], ['monitor', 'bg.monitor'], ['shell', 'bg.shell'], ['other', 'bg.other']]
    .filter(([k]) => j[k] > 0).map(([k, id]) => txt(id, { n: j[k] }));
  return parts.length ? txt('bg.running', { what: parts.join(' · ') }) : txt('bg.running_any');
}

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
  const verb = spin ? spin.verb : txt('chat.working');
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
  chatBg.remove();
  chatNote.remove();
  chatMenu.remove();
  chatPend.remove();
  chatCol.querySelector('.chat-empty')?.remove();
  // New items slide in; a rebuild or a first load of many items just appears.
  const animate = !rebuilt && items.length - shown.n <= 3;
  for (let i = shown.n; i < items.length; i++) {
    const it = items[i];
    if (it.k === 'failed') { markFailed(it.call); continue; }
    const node = chatItemEl(it);
    if (animate) node.classList.add('enter');
    // Tool calls in a row share one compact block.
    const last = chatCol.lastElementChild;
    if (it.k === 'tool' || it.k === 'diff') {
      const box = last && last.classList.contains('tools') ? last : chatCol.appendChild(el('div', 'tools'));
      // A change goes under the call that made it (calls made together come before their
      // results), whose line then carries its counts.
      const call = it.k === 'diff' && it.call && [...box.querySelectorAll('.tool[data-call]')].find((t) => t.dataset.call === it.call);
      if (call && !call.querySelector('.dcount')) {
        call.append(diffCounts(it));
        call.after(node);
        linkDiff(call, node);
      } else {
        if (it.k === 'diff') {
          const head = diffHead(it);
          node.prepend(head);
          linkDiff(head, node);
        }
        box.append(node);
      }
    } else chatCol.append(node);
  }
  shown.n = items.length;
  foldDiffs(s.info.busy);
  const pend = s.pending || [];
  if (!items.length && !pend.length && !s.info.busy && !s.info.menu) chatCol.append(el('div', 'chat-empty', s.chat ? txt('chat.empty') : txt('chat.loading')));
  updateChatWorking(s);
  const menuNew = updateChatMenu(s);
  // An optional survey can be up while Claude works: both show then.
  if (s.info.busy && !(s.info.menu && !s.info.menu.options.some((o) => o.key))) chatCol.append(chatWorking);
  if (s.info.menu) chatCol.append(chatMenu);
  else if (s.info.background && !s.info.busy) {
    chatBgText.textContent = bgText(s.info);
    chatCol.append(chatBg);
  }
  if (s.note) {
    if (s.note !== noteKey) { noteKey = s.note; chatNote.innerHTML = md(s.note); }
    chatCol.insertBefore(chatNote, chatCol.querySelector(':scope > .chat-menu, :scope > .chat-working'));
  }
  const pendNew = renderChatPending(pend, s.info.busy);
  if (pend.length) chatCol.append(chatPend);
  if (force || atBottom || menuNew || pendNew) chat.scrollTop = chat.scrollHeight;
  updateChatHead();
  queueChatRail();
}

// ---- the question being answered, pinned at the top ----
// Once a question's bubble scrolls off the top, a copy (a few lines) stays pinned there while its
// answer is read. The next question pushes it out as it comes up. Clicking it goes back to it.
const chatHead = el('div', 'chat-head');
const chatHeadIn = el('div', 'ch-in');
const chatHeadQ = el('button', 'ch-q');
chatHeadQ.type = 'button';
chatHeadQ.title = txt('chat.goto_question');
const chatHeadT = el('span', 'ch-t'); // a span inside: line clamping doesn't work on a button itself
chatHeadQ.append(chatHeadT);
chatHeadIn.append(chatHeadQ);
chatHead.append(chatHeadIn);
chat.prepend(chatHead);
let headFor = null; // the bubble chatHead shows
let headRaf = 0;

function updateChatHead() {
  const top = chat.getBoundingClientRect().top;
  const qs = chatCol.querySelectorAll('.msg.user:not(.pending)');
  // The last question whose bubble has gone above the top; the one after it is the next.
  let cur = null;
  let next = null;
  for (const q of qs) {
    if (q.getBoundingClientRect().bottom <= top + 4) cur = q;
    else { next = q; break; }
  }
  const on = !!(cur && chatShown() && cur.dataset.q);
  chatHeadIn.classList.toggle('on', on);
  if (!on) return;
  if (cur !== headFor) {
    headFor = cur;
    chatHeadT.textContent = cur.dataset.q;
  }
  // The next question coming up pushes this one out of the way.
  const h = chatHeadQ.offsetHeight + 12;
  const gap = next ? next.getBoundingClientRect().top - top : Infinity;
  chatHeadIn.style.setProperty('--push', `${Math.min(0, gap - h)}px`);
}

chat.addEventListener('scroll', () => {
  if (!headRaf) headRaf = requestAnimationFrame(() => { headRaf = 0; updateChatHead(); });
}, { passive: true });
addEventListener('resize', () => updateChatHead());
chatHeadQ.onclick = () => {
  if (!headFor?.isConnected) return;
  chat.scrollTo({ top: chat.scrollTop + headFor.getBoundingClientRect().top - chat.getBoundingClientRect().top - 12, behavior: 'smooth' });
};

// ---- marks over the scrollbar: the questions and the compactions ----
// Each sits where its bubble is along the scroll track (same scale as the thumb), so the whole
// conversation reads at a glance. Hovering shows the question; clicking scrolls to it.
const chatRail = $('#chat-rail');
const chatRailTip = el('div', 'rail-tip');
chatRailTip.hidden = true;
chatRail.after(chatRailTip);
let railRaf = 0;
let railKey = '';

function queueChatRail() {
  if (!railRaf) railRaf = requestAnimationFrame(() => { railRaf = 0; updateChatRail(); });
}

function updateChatRail() {
  const track = chat.clientHeight;
  const total = chat.scrollHeight;
  const on = chatShown() && total > track + 1;
  chatRail.hidden = !on;
  if (!on) { railKey = ''; chatRailTip.hidden = true; return; }
  const marks = [];
  for (const node of chatCol.children) {
    const q = node.matches('.msg.user:not(.pending)') ? node : node.classList.contains('msg-wrap') ? node.querySelector('.msg.user') : null;
    if (q && q.dataset.q) marks.push({ node, kind: 'q', text: q.dataset.q });
    else if (node.classList.contains('chat-compact')) marks.push({ node, kind: 'c', text: node.textContent });
  }
  // Rows are rounded to whole pixels; marks that land on the same row would only stack.
  let last = -1;
  const rows = [];
  for (const m of marks) {
    const y = Math.round((m.node.offsetTop / total) * track);
    if (y === last && m.kind === 'q') continue;
    last = y;
    rows.push([y, m]);
  }
  const key = JSON.stringify([track, rows.map(([y, m]) => [y, m.kind])]);
  if (key === railKey) { rows.forEach(([, m], i) => { chatRail.children[i]._mark = m; }); return; }
  railKey = key;
  chatRail.replaceChildren(...rows.map(([y, m]) => {
    const b = el('button', `rail-m ${m.kind}`);
    b.type = 'button';
    b.tabIndex = -1;
    b.style.top = `${y}px`;
    b._mark = m;
    return b;
  }));
}

chatRail.addEventListener('mouseover', (e) => {
  const b = e.target.closest('.rail-m');
  if (!b) return;
  chatRailTip.textContent = b._mark.text;
  chatRailTip.classList.toggle('c', b._mark.kind === 'c');
  chatRailTip.hidden = false;
  const max = chatRail.clientHeight - chatRailTip.offsetHeight - 4;
  chatRailTip.style.top = `${Math.max(4, Math.min(max, b.offsetTop - chatRailTip.offsetHeight / 2))}px`;
});
chatRail.addEventListener('mouseout', (e) => { if (e.target.closest('.rail-m')) chatRailTip.hidden = true; });
chatRail.addEventListener('click', (e) => {
  const b = e.target.closest('.rail-m');
  if (!b || !b._mark.node.isConnected) return;
  chatRailTip.hidden = true;
  chat.scrollTo({ top: b._mark.node.offsetTop - 12, behavior: 'smooth' });
});
// Images loading, text rewrapping, the window resizing: all move the marks.
new ResizeObserver(queueChatRail).observe(chatCol);
new ResizeObserver(queueChatRail).observe(chat);

// Messages sent but not yet in the transcript (see addPending), under everything else.
const chatPend = el('div', 'chat-pend');
let pendKey = '';
/** Rebuilds the pending bubbles when they changed; true when one was added. */
function renderChatPending(pend, busy) {
  const key = JSON.stringify([busy, pend.map((p) => p.at)]);
  if (key === pendKey) return false;
  const grew = pend.length > chatPend.childElementCount;
  pendKey = key;
  chatPend.replaceChildren(...pend.map((p) => {
    const d = el('div', `msg user pending${longText(p.text) ? ' long' : ''}`);
    d.append(el('span', 'msg-t', (p.images ? `🖼${p.images} ` : '') + p.text));
    d.append(el('span', 'pend-note', busy ? txt('chat.pend.busy') : txt('chat.pend.sending')));
    return d;
  }));
  return grew;
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
  // An optional question answered by one key (session survey): nothing is highlighted.
  const byKey = m.options.some((o) => o.key);
  menuSel = byKey ? -1 : m.sel;
  const parts = [];
  // An AskUserQuestion with several questions: their headers as tabs, as Claude Code shows them
  // (an older desktop app sends none). No current one = its last page, "Submit".
  const tabs = m.tabs || [];
  if (tabs.length > 1 || (tabs.length && m.tab == null)) {
    const row = el('div', 'mtabs');
    tabs.forEach((h, i) => row.append(el('span', i === m.tab ? 'mtab on' : 'mtab', h)));
    row.append(el('span', m.tab == null ? 'mtab on' : 'mtab', txt('chat.menu.submit_tab')));
    parts.push(row);
  }
  if (m.title) parts.push(el('div', 'mtitle', m.title));
  // A survey's few short answers sit in one row, as Claude Code draws them.
  const list = el('div', byKey ? 'mopts keys' : 'mopts');
  // A settings dialog: rows holding a value ("Also scan shell history  true") read as one
  // grouped list, and a row without one ("Continue") as a button of its own. DOM order stays the
  // options' order, which paintMenuSel relies on.
  const valued = (o) => o.num === null && !o.key && /\S\s{2,}\S/.test(o.label);
  const settings = m.options.some(valued);
  let group = null;
  m.options.forEach((o, i) => {
    const b = el('button', 'mopt');
    b.type = 'button';
    if (o.key) {
      b.append(el('span', 'mnum', o.key), el('span', 'mlabel', o.label));
    } else if (o.num !== null) {
      // A menu without numbers (settings-style dialog) sends num: null; an older desktop app none.
      const lab = el('span', 'mlabel', o.label);
      // A question taking several answers: Enter (a click) checks or unchecks one.
      if (o.checked != null) lab.prepend(el('span', o.checked ? 'mcheck on' : 'mcheck', o.checked ? '☑' : '☐'));
      b.append(el('span', 'mnum', `${o.num ?? i + 1}`), lab);
    } else {
      // "Also scan shell history     true": the setting, then its value on the right.
      b.classList.add('plain');
      const [name, ...val] = o.label.split(/\s{2,}/);
      const lab = el('span', 'mlabel', name);
      if (val.length) lab.append(el('span', 'mval', val.join('  ')));
      b.append(lab);
    }
    if (o.desc) b.append(el('span', 'mdesc', o.desc));
    b.onclick = () => pickMenu(s.id, i);
    if (settings && valued(o)) {
      if (!group) list.append(group = el('div', 'mgroup'));
      group.append(b);
    } else {
      if (settings) b.classList.add('action');
      group = null;
      list.append(b);
    }
  });
  parts.push(list);
  // The highlighted option's preview (a mockup, code), drawn as Claude Code boxes it beside the
  // options; it follows the highlight once the server reads the screen again.
  if (m.preview) parts.push(el('pre', 'mpreview', m.preview));
  // Text between the options and the key hint (an older desktop app sends none).
  if (m.note) parts.push(el('div', 'mtitle mnote', m.note));
  const foot = el('div', 'mfoot');
  const esc = el('button', 'act ghost', txt('chat.cancel_esc'));
  esc.type = 'button';
  esc.onclick = () => { input(s.id, '\x1b'); ta.focus(); };
  const peek = el('button', 'act ghost', txt('chat.menu.peek'));
  peek.type = 'button';
  peek.title = txt('chat.menu.peek_tip');
  peek.onclick = () => { termPeek = s.id; syncChat(true); focusInput(); };
  // The survey has no Esc; its own "닫기" option dismisses it.
  if (byKey) foot.append(peek);
  else foot.append(esc, peek);
  // Several questions, or one taking several answers: ←/→ move between them and to "Submit".
  const stepped = tabs.length > 1 || m.options.some((o) => o.checked != null);
  if (stepped) {
    for (const [label, k, tip] of [['◀', 'D', 'chat.menu.prev_q'], ['▶', 'C', 'chat.menu.next_q']]) {
      const b = el('button', 'act ghost', label);
      b.type = 'button';
      b.title = txt(tip);
      b.onclick = () => { input(s.id, arrowKey(s, k)); ta.focus(); };
      foot.append(b);
    }
  }
  // Dialogs whose rows hold a value ("←/→ to change"): buttons for that, and the hint as shown.
  if (!stepped && m.hint && m.hint.includes('←')) {
    for (const [label, k] of [['◀', 'D'], ['▶', 'C']]) {
      const b = el('button', 'act ghost', label);
      b.type = 'button';
      b.title = txt('chat.menu.adjust');
      b.onclick = () => { input(s.id, arrowKey(s, k)); ta.focus(); };
      foot.append(b);
    }
  }
  foot.append(el('span', 'mhint', byKey ? txt('chat.menu.optional')
    : m.hint && m.options.every((o) => o.num === null) ? m.hint : txt('chat.menu.keys')));
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
  if (!m || !chatShown() || m.options.some((o) => o.key)) return;
  menuSel = Math.max(0, Math.min(m.options.length - 1, menuSel + d));
  paintMenuSel();
}

/** The arrow key sequence for direction `k` (A up, B down, C right, D left) in tab `s`'s mode. */
function arrowKey(s, k) {
  return (s?.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + k;
}

/** Moves Claude's highlight to option `i` with arrow keys, then Enter. */
async function pickMenu(id, i) {
  const s = sessions.get(id);
  if (!s || !s.info.menu || chatMenu.classList.contains('busy')) return;
  chatMenu.classList.add('busy'); // until the server shows the next state
  setTimeout(() => chatMenu.classList.remove('busy'), 3000); // or the pick didn't take
  // A question answered by one key takes just that key.
  const k = s.info.menu.options[i]?.key;
  if (k) { input(id, k); ta.focus(); return; }
  // From where the highlight is now (↑↓ may have moved it since the server last looked).
  const d = i - menuSel;
  menuSel = i;
  paintMenuSel();
  const key = arrowKey(s, d < 0 ? 'A' : 'B');
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

// ---- quote: select text in the conversation, then "인용" (or Ctrl+L) puts it in the input box ----
const quoteBtn = el('button', 'quote-btn');
quoteBtn.type = 'button';
const quoteKbd = el('kbd', '', '');
quoteKbd.dataset.keyKbd = 'quote'; // filled from the shortcut table (keys.js)
quoteBtn.append(el('span', '', txt('chat.quote')), quoteKbd);
quoteBtn.hidden = true;
document.body.append(quoteBtn);
let quoteDrag = false; // a mouse drag in the chat is still going: show the button once it ends

/** The live selection's range when it is non-empty and inside the conversation, else null. */
function quoteRange() {
  if (!chatShown()) return null;
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) return null;
  const r = sel.getRangeAt(0);
  return chatCol.contains(r.commonAncestorContainer) ? r : null;
}

function placeQuote() {
  const r = !quoteDrag && quoteRange();
  const rects = r ? [...r.getClientRects()].filter((x) => x.width || x.height) : [];
  const box = chat.getBoundingClientRect();
  const last = rects[rects.length - 1];
  // Hidden while the selection's end is scrolled out of the conversation.
  if (!last || last.bottom < box.top || last.top > box.bottom) { quoteBtn.hidden = true; return; }
  quoteBtn.hidden = false;
  const w = quoteBtn.offsetWidth, h = quoteBtn.offsetHeight;
  // Below the end of the selection; above its start when that would leave the conversation.
  let top = last.bottom + 6;
  if (top + h > box.bottom - 4) top = Math.max(box.top + 4, rects[0].top - h - 6);
  const left = Math.min(Math.max(box.left + 4, last.right - w / 2), box.right - w - 4);
  quoteBtn.style.top = `${top}px`;
  quoteBtn.style.left = `${left}px`;
}

/** Adds the selected text as a quote chip on the input box and moves focus there. */
function quoteSel() {
  if (!quoteRange()) return;
  const q = getSelection().toString().replace(/\r/g, '').replace(/^\s+|\s+$/g, '');
  getSelection().removeAllRanges();
  quoteBtn.hidden = true;
  if (!q) return;
  quotes.push(q);
  renderQuotes();
  ta.focus();
}

quoteBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
quoteBtn.addEventListener('click', quoteSel);
chat.addEventListener('mousedown', (e) => { if (e.button === 0) { quoteDrag = true; quoteBtn.hidden = true; } });
addEventListener('mouseup', () => { if (quoteDrag) { quoteDrag = false; requestAnimationFrame(placeQuote); } });
let quoteTimer = 0;
document.addEventListener('selectionchange', () => { clearTimeout(quoteTimer); quoteTimer = setTimeout(placeQuote, touch ? 250 : 60); });
chat.addEventListener('scroll', () => { if (!quoteBtn.hidden || quoteRange()) placeQuote(); }, { passive: true });
addEventListener('resize', () => { if (!quoteBtn.hidden) placeQuote(); });
// The quote key (Ctrl+L by default) quotes only while there is a selection in the conversation;
// otherwise it stays the terminal's.
addEventListener('keydown', (e) => {
  if (keyAction(e) === 'quote' && quoteRange()) { e.preventDefault(); e.stopPropagation(); quoteSel(); }
}, true);

syncChat(true);
