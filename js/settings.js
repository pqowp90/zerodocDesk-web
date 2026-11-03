// DeskDoc web client: app updates, the settings dialog, this PC's app settings, top bar, user buttons.
'use strict';

// ---- app updates (desktop window only; the server downloads and verifies) ----
const canUpdate = isDesktop && !p2pMode;
let upd = null;
let requiredShown = false;
let installTotal = 0; // longest countdown seen, so the bar can fill toward the install

/** 'wait' | 'resume' from prefs; null = an older desktop app without the setting */
let updMode = null;
function updAction(action) { send({ t: 'update', action }); }
for (const r of document.querySelectorAll('input[name="upd-mode"]')) {
  r.onchange = () => {
    updMode = r.value;
    send({ t: 'update_mode', mode: r.value });
    if (upd) onUpdate(upd);
  };
}
$('#upd-dev').onchange = (e) => updAction(e.target.checked ? 'channel_dev' : 'channel_stable');

function onUpdate(m) {
  if (!canUpdate) return;
  upd = m;
  const counting = m.install_in != null;
  installTotal = counting ? Math.max(installTotal, m.install_in) : 0;
  const b = $('#update-btn');
  b.hidden = !m.available;
  b.className = 'act' + (m.required ? ' required' : '') + (m.state === 'downloading' || counting ? ' busy' : '');
  const working = [...sessions.values()].filter((s) => s.info.busy || s.info.asking).length;
  b.textContent = counting ? `${m.install_in}초 뒤 업데이트`
    : m.when_idle ? (working && !m.resume ? '작업 끝나면 업데이트' : '곧 업데이트')
    : m.state === 'downloading' ? `업데이트 받는 중 ${m.progress}%`
    : m.state === 'ready' ? (m.on_exit ? '끌 때 업데이트' : '업데이트 준비됨')
    : m.required ? '필수 업데이트' : '새 업데이트';
  b.title = m.required ? '이 버전은 지원이 끝났어요. 업데이트해 주세요.' : `v${m.latest} · 새 버전 정보 보기`;
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
  const counting = m.install_in != null;
  $('#upd-bar').hidden = m.state !== 'downloading' && !counting;
  $('#upd-bar > div').style.width = counting
    ? `${Math.round(((installTotal - m.install_in) / installTotal) * 100)}%` : `${m.progress}%`;

  const resume = updMode === 'resume';
  const workingNote = resume ? '업데이트하면 다시 켜질 때 열린 탭을 그대로 열어요.'
    : working ? `지금 작업 중인 대화 ${working}개.` : '작업 중인 대화가 없어요.';
  const state = counting
    ? `대화가 모두 끝났어요. ${m.install_in}초 뒤 설치하고 다시 시작해요.`
    : m.when_idle
    ? (m.state === 'downloading' ? `받는 중 ${m.progress}% · ` : '')
      + (m.resume ? '받는 대로 설치하고 다시 시작해요. 열린 탭은 다시 열려요.'
        : working ? `작업 중인 대화 ${working}개가 끝나면 자동으로 설치하고 다시 시작해요.` : '곧 설치하고 다시 시작해요…')
    : {
      checking: '확인하는 중…',
      downloading: `받는 중 ${m.progress}% (검증까지 끝나면 설치할 수 있어요)`,
      ready: m.on_exit ? '앱을 끌 때 설치돼요.' : `받아 뒀어요. ${workingNote}`,
    }[m.state] || (m.available && m.dev ? '개발 빌드라 자동으로 받지 않아요.' : '');
  const checked = m.checked_at ? `마지막 확인 ${ago(m.checked_at)}${ago(m.checked_at) === '방금' ? '' : ' 전'}` : '';
  $('#upd-state').textContent = [m.required && m.available ? '이 버전은 지원이 끝났어요.' : '', state, checked].filter(Boolean).join(' · ');
  $('#upd-dev').checked = m.channel === 'dev';
  // Newer apps follow one channel of their own (DeskDoc / DeskDoc Dev): no switch to show.
  $('#upd-ch-row').hidden = !!m.channel_fixed;
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
    // Main choice. Resume mode: install as soon as it's downloaded, the tabs open again after.
    // Otherwise wait for the running conversations, then install by itself; with nothing
    // working that is right away (download, then a few seconds of idle).
    acts.push(resume
      ? btn('지금 업데이트', 'act', () => {
        if (working && !confirm(`작업 중인 대화 ${working}개의 응답이 끊겨요. 탭은 다시 열리니 이어서 말해 주세요. 지금 업데이트할까요?`)) return;
        updAction('install_when_idle');
      })
      : working
      ? btn(`작업 ${working}개 끝나면 업데이트`, 'act', () => updAction('install_when_idle'))
      : btn('지금 업데이트', 'act', () => {
        if (tabs && !confirm(`열린 탭 ${tabs}개가 닫혀요(대화는 사이드바에서 다시 열 수 있어요). 지금 업데이트할까요?`)) return;
        updAction('install_when_idle');
      }));
    if (m.state === 'ready') {
      if (working && !resume) acts.push(btn('지금 바로 설치', 'act ghost', () => {
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
$('#settings').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget && !isNavButton(e)) closeSettings(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#settings').hidden) { e.preventDefault(); e.stopPropagation(); closeSettings(); } }, true);
// Remote access and updates belong to the desktop window only.
if (!canUpdate) document.querySelector('.set-nav [data-pane="update"]').hidden = true;
if (!isDesktop || p2pMode) document.querySelector('.set-nav [data-pane="remote"]').hidden = true;
if (!isDesktop || p2pMode) document.querySelector('.set-nav [data-pane="notify"]').hidden = true;

// ---- this PC's app settings (desktop window) ----
function onPrefs(m) {
  $('#notify-os').checked = !!m.notify_os;
  // This PC's Claude usage: the desktop window only; an older desktop app sends no such pref.
  $('#menu-ko-row').hidden = !isDesktop || p2pMode || m.menu_translate === undefined;
  $('#menu-translate').checked = !!m.menu_translate;
  if (Array.isArray(m.top_bar)) { topBar = m.top_bar; applyTopBar(); renderBarSet(); }
  if (m.update_mode) {
    updMode = m.update_mode;
    $('#upd-mode').hidden = false;
    const r = $(`#upd-mode-${updMode}`);
    if (r) r.checked = true;
    if (upd) onUpdate(upd);
  }
}
$('#notify-os').onchange = (e) => send({ t: 'notify', on: e.target.checked });
$('#notify-test').onclick = () => send({ t: 'notify_test' });
$('#menu-translate').onchange = (e) => send({ t: 'menu_translate', on: e.target.checked });

// ---- top bar: the server keeps its layout (topbar.rs); the page only moves and hides elements ----
/** @type {null | {id:string, shown:boolean, label:string, required:boolean}[]} null = an older desktop app: keep the bar as is */
let topBar = null;
function applyTopBar() {
  const bar = $('#bar'), end = $('#remote-btn'); // the fixed part stays on the right
  // User buttons whose script is gone
  for (const el of bar.querySelectorAll('[data-bar^="btn:"]')) if (!topBar.some((s) => s.id === el.dataset.bar)) el.remove();
  for (const s of topBar) {
    const el = bar.querySelector(`[data-bar="${CSS.escape(s.id)}"]`) || (s.button && userButton(s.id));
    if (!el) continue; // an item this page doesn't have
    if (s.button) drawUserButton(el, s.button);
    bar.insertBefore(el, end);
    el.classList.toggle('bar-off', !s.shown);
  }
}

// ---- user buttons: scripts in this PC's buttons folder (buttons.rs); pressing one runs it there ----
function userButton(id) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'act ghost ubtn' });
  b.dataset.bar = id;
  b.onclick = () => {
    if (b.classList.contains('busy')) return;
    b.classList.add('busy');
    if (b._info.in_tab) wantActivate++; // it opens a tab: show it
    send({ t: 'button', file: b._info.file, tab: active });
  };
  return b;
}
function drawUserButton(el, info) {
  el._info = info;
  el.textContent = info.icon ? `${info.icon} ${info.label}` : info.label;
  el.title = info.tip || info.label;
}
function onButtonDone(m) {
  const el = $('#bar').querySelector(`[data-bar="${CSS.escape('btn:' + m.file)}"]`);
  if (el) el.classList.remove('busy');
  toast(m.error || m.msg);
}
// Shown right away, so a second click before the server's `prefs` comes back builds on this one.
function sendTopBar(list) {
  topBar = list; applyTopBar(); renderBarSet();
  send({ t: 'topbar', items: list.map(({ id, shown }) => ({ id, shown })) });
}
function renderBarSet() {
  if (!topBar) return;
  const rows = topBar.map((s, i) => {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const sw = document.createElement('label');
    sw.className = 'sw';
    sw.title = s.required ? '숨길 수 없어요' : (s.shown ? '숨기기' : '보이기');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: s.shown, disabled: s.required });
    cb.onchange = () => sendTopBar(topBar.map((o, j) => (j === i ? { ...o, shown: cb.checked } : o)));
    sw.append(cb, document.createElement('span'));
    const name = Object.assign(document.createElement('span'), { className: 'bar-name', textContent: s.label });
    const move = (d) => {
      const l = topBar.slice();
      [l[i], l[i + d]] = [l[i + d], l[i]];
      sendTopBar(l);
    };
    const up = Object.assign(document.createElement('button'), { type: 'button', className: 'icon', textContent: '↑', title: '앞으로', disabled: i === 0 });
    const down = Object.assign(document.createElement('button'), { type: 'button', className: 'icon', textContent: '↓', title: '뒤로', disabled: i === topBar.length - 1 });
    up.onclick = () => move(-1);
    down.onclick = () => move(1);
    row.append(sw, name, up, down);
    return row;
  });
  $('#bar-items').replaceChildren(...rows);
}
$('#bar-reset').onclick = () => send({ t: 'topbar', items: [] });
$('#buttons-folder').onclick = () => send({ t: 'buttonsfolder' });
// Only the desktop window changes this PC's settings; an older desktop app sends no layout.
$('#bar-set').hidden = !isDesktop || p2pMode;
// The remote button. The desktop window talks to its own PC (always connected), so there the dot
// shows whether another device is connected now (see onRemote) and the button opens settings › remote.
// Other devices have no remote settings: the button is just their connection dot.
const localDesk = isDesktop && !p2pMode;
if (localDesk) {
  $('#conn').className = 'dot idle';
  $('#remote-btn').title = '리모트 · 지금 연결된 기기 없음';
  $('#remote-btn').onclick = () => (paneOpen('remote') ? closeSettings() : openSettings('remote'));
} else {
  $('#remote-btn').classList.add('just-dot');
  $('#remote-btn').tabIndex = -1;
}
function showConn(on) {
  if (localDesk) return;
  $('#conn').className = on ? 'dot on' : 'dot off';
  $('#remote-btn').title = on ? '데스크탑에 연결됨' : '데스크탑 연결 끊김';
}

/** A Windows notification for tab `id` was clicked: the window is up, show that tab. */
function onShow(m) {
  if (!sessions.has(m.id)) return;
  closeSettings();
  activate(m.id);
  $('#toast').hidden = true;
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
