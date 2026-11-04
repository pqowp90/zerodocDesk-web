// DeskDoc web client: skills: Claude Code plugins for the account or one project.
'use strict';

// ---- skills: Claude Code plugins, for the whole account or one project (just me) ----
// The server runs `claude plugin …`; settings live in Claude Code's own files, not here.
const ZERODOC_REPO = 'pqowp90/zerodoc-skills';
let skScope = load('zd-sk-scope') === 'local' ? 'local' : 'user';
let skCwd = load('zd-sk-cwd') || null;
let skData = null;
let skBusy = null; // id (or repo) of the change in flight
let skQTimer = 0;
let skCat = ''; // catalog category filter, '' = all

// Category ids the text table knows (skills.cat.<id>); others show their own name.
const SK_CATS = new Set(['development', 'productivity', 'database', 'monitoring', 'security', 'deployment', 'design', 'automation', 'learning', 'location', 'testing', 'math', 'migration']);
function skCatName(id) { return SK_CATS.has(id) ? txt('skills.cat.' + id) : id; }

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
  send({ t: 'skills', cwd: skScope === 'local' ? skCwd : null, q: $('#sk-q').value, cat: skCat });
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
    ? txt('skills.hint.user')
    : skCwd ? txt('skills.hint.local') : txt('skills.hint.no_folder');
}

function skApply(op, id, key = id) {
  if (skBusy) { toast(txt('skills.busy'), 2000); return; }
  const scope = skScope === 'local' ? 'local' : 'user';
  if (scope === 'local' && !skCwd && op !== 'market_add') { toast(txt('skills.pick_folder')); return; }
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

/** 1234 → "1.2K", 1266133 → "1.3M". */
function skCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}

function skRow(name, market, desc, installs = 0, author = '') {
  const row = el('div', 'sk-row');
  const main = el('div', 'sk-main');
  const title = el('div', 'sk-name', name);
  title.append(el('span', 'sk-mk', market));
  if (author) {
    const a = el('button', 'sk-mk sk-author', `@${author}`);
    a.title = txt('skills.author_only', { author });
    a.onclick = () => { $('#sk-q').value = `@${author}`; skRequest(); };
    title.append(a);
  }
  if (installs > 0) {
    const n = el('span', 'sk-mk', `↓ ${skCount(installs)}`);
    n.title = txt('skills.installs', { n: installs.toLocaleString() });
    title.append(n);
  }
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
    c.append(el('span', '', txt('skills.connect.text')));
    const b = el('button', 'act', skBusy === ZERODOC_REPO ? txt('skills.connect.busy') : txt('skills.connect.btn'));
    b.disabled = !!skBusy;
    b.onclick = () => skApply('market_add', ZERODOC_REPO);
    c.append(b);
    card.append(c);
  }

  const list = $('#sk-list');
  if (!m.items.length) list.replaceChildren(el('div', 'side-empty', txt('skills.empty')));
  else list.replaceChildren(...m.items.map((it) => {
    const { row, main } = skRow(it.name, it.market, it.description);
    if (skBusy === it.id) row.classList.add('busy');
    const on = local ? it.on : it.user === true;
    const note = el('div', 'sk-note');
    if (local) {
      if (it.local !== null) {
        note.append(el('span', '', it.local ? txt('skills.note.local_on') : txt('skills.note.local_off')));
        const r = el('button', '', txt('skills.note.follow_account'));
        r.title = txt('skills.note.account_state', { state: it.user ? txt('skills.state.on') : txt('skills.state.off') });
        r.onclick = () => skApply('reset', it.id);
        note.append(r);
      } else if (it.project !== null) note.append(el('span', '', txt('skills.note.team', { state: it.project ? txt('skills.state.on') : txt('skills.state.off') })));
      else note.append(el('span', '', it.user ? txt('skills.note.account_on') : txt('skills.note.account_off')));
    } else {
      if (it.scopes.includes('user')) {
        const del = el('button', '', txt('skills.delete'));
        del.onclick = () => { if (confirm(txt('skills.delete_confirm', { name: it.name }))) skApply('uninstall', it.id); };
        note.append(del);
      } else if (it.scopes.length) note.append(el('span', '', txt('skills.note.some_projects')));
    }
    if (note.childElementCount) main.append(note);
    row.append(skSwitch(on, (v) => skApply(v ? 'on' : 'off', it.id)));
    return row;
  }));

  // Category chips; the chosen one stays even when the search leaves nothing in it.
  const cats = m.categories.slice();
  if (skCat && !cats.some((c) => c.name === skCat)) cats.push({ name: skCat, count: 0 });
  const chip = (name, label, count) => {
    const b = el('button', name === skCat ? 'on' : '', label);
    if (count !== null) b.append(el('span', '', String(count)));
    b.onclick = () => { if (skCat === name) return; skCat = name; renderSkills(); skRequest(); };
    return b;
  };
  $('#sk-cats').replaceChildren(...(cats.length
    ? [chip('', txt('skills.cat.all'), null), ...cats.map((c) => chip(c.name, skCatName(c.name), c.count))]
    : []));

  const res = $('#sk-results');
  const q = $('#sk-q').value.trim();
  $('#sk-q').placeholder = txt('skills.search_ph', { n: m.total.toLocaleString() });
  const rows = m.results.map((r) => {
    const { row } = skRow(r.name, r.market, r.description, r.installs, r.author);
    if (skBusy === r.id) row.classList.add('busy');
    const b = el('button', 'act', skBusy === r.id ? txt('skills.installing') : local ? txt('skills.add_project') : txt('skills.add'));
    b.onclick = () => skApply('on', r.id);
    row.append(b);
    return row;
  });
  if (m.found > m.results.length) rows.push(el('div', 'side-empty', txt('skills.more', { n: m.found - m.results.length })));
  if (!rows.length) rows.push(el('div', 'side-empty', q || skCat ? txt('skills.none_found') : txt('skills.none_addable')));
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
  else toast(txt('skills.applied', { msg: m.msg }), 4000);
  renderSkills();
  skRequest();
}

for (const b of document.querySelectorAll('.sk-scope button')) {
  b.onclick = () => {
    skScope = b.dataset.scope; store('zd-sk-scope', skScope);
    skData = null; $('#sk-list').replaceChildren(el('div', 'side-empty', txt('skills.loading')));
    renderSkillScope(); skRequest();
  };
}
$('#sk-proj').onchange = (e) => { skCwd = e.target.value; store('zd-sk-cwd', skCwd); renderSkillScope(); skRequest(); };
$('#sk-q').oninput = () => { clearTimeout(skQTimer); skQTimer = setTimeout(skRequest, 250); };
$('#sk-add').onsubmit = (e) => {
  e.preventDefault();
  const repo = $('#sk-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast(txt('skills.repo_format')); return; }
  skApply('market_add', repo);
  $('#sk-repo').value = '';
};
