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

const SK_CATS = {
  development: '개발', productivity: '생산성', database: '데이터베이스', monitoring: '모니터링',
  security: '보안', deployment: '배포', design: '디자인', automation: '자동화', learning: '학습',
  location: '위치', testing: '테스트', math: '수학', migration: '마이그레이션',
};

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
    a.title = `${author}의 스킬만 보기`;
    a.onclick = () => { $('#sk-q').value = `@${author}`; skRequest(); };
    title.append(a);
  }
  if (installs > 0) {
    const n = el('span', 'sk-mk', `↓ ${skCount(installs)}`);
    n.title = `${installs.toLocaleString()}명이 설치`;
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
    ? [chip('', '전체', null), ...cats.map((c) => chip(c.name, SK_CATS[c.name] || c.name, c.count))]
    : []));

  const res = $('#sk-results');
  const q = $('#sk-q').value.trim();
  $('#sk-q').placeholder = `이름·설명·만든 사람으로 검색 (${m.total.toLocaleString()}개)`;
  const rows = m.results.map((r) => {
    const { row } = skRow(r.name, r.market, r.description, r.installs, r.author);
    if (skBusy === r.id) row.classList.add('busy');
    const b = el('button', 'act', skBusy === r.id ? '설치 중…' : local ? '이 프로젝트에 추가' : '추가');
    b.onclick = () => skApply('on', r.id);
    row.append(b);
    return row;
  });
  if (m.found > m.results.length) rows.push(el('div', 'side-empty', `${m.found - m.results.length}개 더 있어요 · 검색어를 더 적어 보세요`));
  if (!rows.length) rows.push(el('div', 'side-empty', q || skCat ? '찾는 스킬이 없어요' : '추가할 수 있는 스킬이 없어요'));
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
