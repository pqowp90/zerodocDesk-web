// DeskDoc web client: sidebar (projects, past conversations, their menu), shortcuts, mouse back/forward.
'use strict';

// ---- sidebar: projects and their past Claude conversations ----
let projects = [];
let openProjects = new Set();
try { openProjects = new Set(JSON.parse(load('zd-open') || '[]')); } catch {}
const showAll = new Set();

// Every working glyph turns in step: a CSS animation starts whenever its element appears (re-render,
// hover ending), so pin each one's start to the document timeline origin instead.
document.addEventListener('animationstart', (e) => {
  if (e.animationName !== 'spin-glyph') return;
  for (const a of e.target.getAnimations({ subtree: true })) {
    if (a.animationName === 'spin-glyph') a.startTime = 0;
  }
});

function ago(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return txt('side.ago.now');
  if (d < 3600) return txt('side.ago.m', { n: Math.floor(d / 60) });
  if (d < 86400) return txt('side.ago.h', { n: Math.floor(d / 3600) });
  if (d < 86400 * 30) return txt('side.ago.d', { n: Math.floor(d / 86400) });
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

// Project order is the user's and lives on the desktop (one order for every device): the server
// lists in it, and dragging a project head asks the server to move it.
let dragProj = null; // path being dragged; re-renders wait until the drag ends
let renderPending = false;

/** Where a conversation goes in its folder, as [group, time]: working (latest started first), then
 *  the rest. The server lists in this order too (history::working_first); applied here as well so
 *  a row moves the moment its tab starts or stops working. */
function convRank(tab) {
  if (!tab || !tab.info.alive) return [0, 0];
  if (tab.info.working_since != null) return [1, tab.info.working_since];
  if (tab.info.busy) return [1, tab.info.since]; // older desktop app: no working_since
  return [0, 0];
}

function renderProjects() {
  // Not while a project is dragged or a name is being typed: re-rendering would drop either.
  if (dragProj !== null || renaming) { renderPending = true; return; }
  const box = $('#projects');
  if (!projects.length) { box.replaceChildren(el('div', 'side-empty', txt('side.no_history'))); return; }
  // Plain shell tabs have no conversation to list; without the tab bar this is the way back to them.
  const shells = [...sessions.values()].filter((s) => !s.info.claude);
  const shellBox = [];
  if (shells.length) {
    const wrap = el('div', 'proj open');
    wrap.append(el('div', 'proj-head', txt('side.shell')));
    const list = el('div', 'proj-list');
    for (const s of shells) {
      const row = el('div', 'sess' + (s.id === active ? ' current' : ''));
      row.append(el('span', 'sdot'), el('span', 'stitle', s.osTitle || s.info.title));
      const x = el('button', 'icon', '×');
      x.title = txt('side.shell_close');
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
    add.title = txt('side.new_here', { name: p.name });
    add.onclick = (e) => { e.stopPropagation(); newTab(true, { cwd: p.path, title: p.name }); };
    // Blue badge = conversations in this folder that finished and you haven't opened yet (the rows' blue dots).
    // Only while collapsed: once open, the rows' own dots already say it.
    const doneN = [...sessions.values()].filter((s) => s.done && !s.info.busy && samePath(s.info.cwd, p.path)).length;
    head.append(caret, name);
    if (doneN && !openProjects.has(p.path)) {
      const badge = el('span', 'run-badge done', String(doneN));
      badge.title = txt('side.done_badge', { n: doneN });
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
      // Shown at once; the server's next listing comes in the same order.
      send({ t: 'proj_move', path: moved.path, before: projects[to + 1]?.path ?? null });
      renderPending = true; // dragend re-renders
    };
    const list = el('div', 'proj-list');
    const limit = showAll.has(p.path) ? p.sessions.length : 8;
    // The tab running each conversation: as matched by the server, or one we opened with --resume
    // (covers the moment before the next projects refresh).
    const convs = p.sessions.map((s) => ({ s, tab: (s.tab != null && sessions.get(s.tab))
      || [...sessions.values()].find((t) => t.info.alive && t.info.resume === s.id) }));
    for (const c of convs) c.rank = convRank(c.tab);
    convs.sort((a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1]); // stable: the rest keep the server's order
    for (const { s, tab } of convs.slice(0, limit)) {
      const busy = tab && tab.info.busy;
      const done = !busy && tab && tab.done;
      const row = el('div', 'sess' + (tab && tab.id === active ? ' current' : '') + (busy ? ' busy' : ''));
      row.title = s.title;
      // Right slot: Claude's turning glyph (orange, no text) while working → a blue dot once it
      // finishes (until opened) → an orange ring while background commands (shells, monitors)
      // outlive the turn → last-modified time.
      let when;
      if (done) when = el('span', 'done-dot');
      else if (busy) {
        when = el('span', 'sglyph');
        when.title = txt('side.working');
      } else if (tab && tab.info.background) {
        when = el('span', 'bg-ring');
        when.title = bgText(tab.info);
      } else when = el('span', 'when', ago(s.mtime));
      if (done) when.title = txt('side.done_unseen');
      // "⋯" takes the right slot's place on hover and opens the conversation menu (so does right-click).
      const more = el('button', 'icon more', '⋯');
      more.title = txt('side.more');
      more.onclick = (e) => { e.stopPropagation(); openConvMenu(row, s, more); };
      row.oncontextmenu = (e) => { e.preventDefault(); openConvMenu(row, s, null, e); };
      row.dataset.conv = s.id;
      if (convMenu.conv === s.id && !convMenu.el.hidden) row.classList.add('menu-open');
      row.append(el('span', 'sdot'), el('span', 'stitle', s.title), when, more);
      row.onclick = () => {
        if (tab) activate(tab.id);
        else newTab(true, { cwd: p.path, resume: s.id, title: s.title.slice(0, 30) });
        if (narrow()) toggleSide(false);
      };
      list.append(row);
    }
    if (p.sessions.length > limit) {
      const more = el('div', 'sess-more', txt('side.older', { n: p.sessions.length - limit }));
      more.onclick = () => { showAll.add(p.path); renderProjects(); };
      list.append(more);
    } else if (showAll.has(p.path) && p.sessions.length > 8) {
      const less = el('div', 'sess-more', txt('side.fold'));
      less.onclick = () => { showAll.delete(p.path); renderProjects(); };
      list.append(less);
    }
    if (!p.sessions.length) list.append(el('div', 'side-empty', txt('side.no_convs')));
    wrap.append(head, list);
    return wrap;
  }));
}

// ---- conversation menu (sidebar "⋯"): rename, delete ----
const ICONS = {
  rename: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M10.5 2.5l3 3L5 14H2v-3z"/><path d="M9 4l3 3"/></svg>',
  delete: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5"/></svg>',
};
const convMenu = { el: el('div', 'conv-menu'), conv: null, row: null };
convMenu.el.hidden = true;
document.body.append(convMenu.el);
let renaming = null; // conversation id whose name is being typed

function menuItem(icon, label, cls, onclick) {
  const b = el('button', 'cm-i' + (cls ? ' ' + cls : ''));
  b.type = 'button';
  const i = el('span', 'cm-ic');
  i.innerHTML = ICONS[icon] || '';
  b.append(i, el('span', '', label));
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}

/** Opens the menu for conversation `c` (a projects-list session) under `anchor`, or at the mouse. */
function openConvMenu(row, c, anchor, ev) {
  const m = convMenu.el;
  if (!m.hidden && convMenu.conv === c.id && anchor) { closeConvMenu(); return; }
  closeConvMenu();
  convMenu.conv = c.id;
  convMenu.row = row;
  row.classList.add('menu-open');
  m.replaceChildren(
    menuItem('rename', txt('side.rename'), '', () => { closeConvMenu(); startRename(row, c); }),
    el('div', 'cm-sep'),
    menuItem('delete', txt('side.delete'), 'danger', () => confirmDelete(c)),
  );
  m.hidden = false;
  const r = anchor ? anchor.getBoundingClientRect() : { left: ev.clientX, right: ev.clientX, top: ev.clientY, bottom: ev.clientY };
  const w = m.offsetWidth, h = m.offsetHeight;
  let x = anchor ? r.right - w : r.left;
  let y = r.bottom + 4;
  if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 4);
  m.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
  m.style.top = y + 'px';
}

function closeConvMenu() {
  convMenu.el.hidden = true;
  convMenu.row?.classList.remove('menu-open');
  convMenu.conv = convMenu.row = null;
}
document.addEventListener('pointerdown', (e) => { if (!convMenu.el.hidden && !isNavButton(e) && !e.target.closest('.conv-menu, .sess .more')) closeConvMenu(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !convMenu.el.hidden) { e.preventDefault(); e.stopPropagation(); closeConvMenu(); } }, true);
$('#projects').addEventListener('scroll', closeConvMenu);
addEventListener('resize', closeConvMenu);

/** The menu turns into "delete for good?" with cancel / delete. */
function confirmDelete(c) {
  const m = convMenu.el;
  const q = el('div', 'cm-q');
  q.append(el('b', '', txt('side.delete_q')), el('span', '', c.tab != null ? txt('side.delete_note_tab') : txt('side.delete_note')));
  const row = el('div', 'cm-btns');
  const no = el('button', 'act ghost', txt('side.cancel'));
  no.onclick = (e) => { e.stopPropagation(); closeConvMenu(); };
  const yes = el('button', 'act danger', txt('side.delete'));
  yes.onclick = (e) => {
    e.stopPropagation();
    convMenu.row?.classList.add('removing');
    closeConvMenu();
    send({ t: 'conv_delete', conv: c.id });
  };
  row.append(no, yes);
  m.replaceChildren(q, row);
  yes.focus();
}

/** The row's title becomes a text box: Enter saves, Esc cancels, clicking away saves. */
function startRename(row, c) {
  const title = row.querySelector('.stitle');
  if (!title) return;
  renaming = c.id;
  const inp = el('input', 'rename-in');
  inp.value = c.title;
  inp.maxLength = 200;
  title.replaceWith(inp);
  row.classList.add('editing');
  inp.focus();
  inp.select();
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const name = inp.value.replace(/\s+/g, ' ').trim();
    renaming = null;
    if (save && name && name !== c.title) {
      c.title = name; // shown right away; the server's answer confirms it
      send({ t: 'conv_rename', conv: c.id, title: name });
    }
    renderPending = false;
    renderProjects();
  };
  inp.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  inp.onblur = () => finish(true);
  inp.onclick = (e) => e.stopPropagation();
}

function onConvDone(m) {
  if (m.error) toast(m.error, 6000);
  else if (m.op === 'delete') toast(txt('side.deleted'), 2500);
  send({ t: 'projects' });
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
    const p = prompt(txt('side.folder_prompt'));
    if (p) { send({ t: 'addfolder', path: p }); setTimeout(() => send({ t: 'projects' }), 300); }
  } else if (m.path) send({ t: 'projects' });
}
setInterval(() => { if (!document.body.classList.contains('side-hidden')) send({ t: 'projects' }); }, 60000);

/** The app-level action for a key event, or null if the key belongs to the terminal. */
/** The keys come from the server's shortcut table (keys.js); `quote` is chat-live.js's. */
function shortcutFor(e) {
  const a = keyAction(e);
  if (a === 'new_tab') return () => newTab(true);
  if (a === 'toggle_side') return () => toggleSide();
  if (a === 'toggle_chat') return () => setChatPref(!chatPref);
  if (a === 'close_tab') return () => { if (active !== null) closeTab(active); };
  if (a === 'next_tab' || a === 'prev_tab') return () => {
    const ids = [...sessions.keys()];
    if (ids.length) activate(ids[(ids.indexOf(active) + (a === 'prev_tab' ? ids.length - 1 : 1)) % ids.length]);
  };
  if (a === 'font_bigger' || a === 'font_smaller' || a === 'font_reset') return () => {
    fontSize = a === 'font_reset' ? (touch ? 12 : 14) : Math.min(28, Math.max(8, fontSize + (a === 'font_smaller' ? -1 : 1)));
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

// ---- mouse back / forward buttons: like a browser, over the conversations shown ----
// Back first closes whatever is open on top (image, model menu, settings).
function navStep(dir) {
  if (dir < 0) {
    if (!viewer.hidden) { closeViewer(); return; }
    if (!modelMenu.hidden) { showModelMenu(false); focusInput(); return; }
    if (!$('#settings').hidden) { closeSettings(); return; }
  }
  const [from, to] = dir < 0 ? [nav.back, nav.fwd] : [nav.fwd, nav.back];
  let id;
  do id = from.pop(); while (id !== undefined && (!sessions.has(id) || id === active));
  if (id === undefined) return;
  if (active !== null) to.push(active);
  closeSettings();
  navStepping = true;
  try { activate(id); } finally { navStepping = false; }
}
/** Mouse back/forward (X1/X2). Outside-click handlers skip them: navStep closes the popup itself,
 * and closing it on press would let the release go on to switch tabs. */
function isNavButton(e) { return e.button === 3 || e.button === 4; }
// Buttons 3/4 are X1/X2. Taken in the capture phase so xterm never sees them, and cancelled so
// the browser/WebView2 doesn't navigate the page itself (Chromium does that on mouseup).
for (const type of ['mousedown', 'mouseup', 'auxclick']) {
  addEventListener(type, (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    e.stopPropagation();
    if (type === 'mouseup') navStep(e.button === 3 ? -1 : 1);
  }, true);
}
