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

function onUpdate(m) {
  if (!canUpdate) return;
  upd = m;
  const counting = m.install_in != null;
  installTotal = counting ? Math.max(installTotal, m.install_in) : 0;
  const b = $('#update-btn');
  b.hidden = !m.available;
  b.className = 'act' + (m.required ? ' required' : '') + (m.state === 'downloading' || counting ? ' busy' : '');
  // What a scheduled install waits for (as the server's `holds_update`): turns in progress unless
  // it resumes them, and background commands always (a restart loses them).
  const held = [...sessions.values()].filter((s) => s.info.background || (!m.resume && (s.info.busy || s.info.asking))).length;
  b.textContent = counting ? txt('settings.update.btn.counting', { n: m.install_in })
    : m.when_idle ? (held ? txt('settings.update.btn.when_idle_held') : txt('settings.update.btn.when_idle'))
    : m.state === 'downloading' ? txt('settings.update.btn.downloading', { p: m.progress })
    : m.state === 'ready' ? (m.on_exit ? txt('settings.update.btn.on_exit') : txt('settings.update.btn.ready'))
    : m.required ? txt('settings.update.required') : txt('settings.update.btn.new');
  b.title = m.required ? txt('settings.update.btn.required_tip') : txt('settings.update.btn.new_tip', { v: m.latest });
  // A required update opens the panel once by itself.
  if (m.required && m.available && !requiredShown) { requiredShown = true; openSettings('update'); }
  renderUpdate();
}

function renderUpdate() {
  const m = upd;
  if (!m || !paneOpen('update')) return;
  const tabs = [...sessions.values()].filter((s) => s.info.alive).length;
  const working = [...sessions.values()].filter((s) => s.info.busy || s.info.asking || s.info.background).length;
  $('#upd-title').textContent = m.required && m.available ? txt('settings.update.required') : m.available ? txt('settings.update.title.available') : txt('settings.update.title');
  $('#upd-ver').textContent = m.available
    ? `v${m.current} → v${m.latest}${m.pub_date ? ` · ${m.pub_date.slice(0, 10)}` : ''}`
    : `v${m.current}${m.latest && m.state !== 'error' ? txt('settings.update.latest_suffix') : ''}`;
  $('#upd-notes').replaceChildren(...(m.available ? m.notes : []).map((n) => el('li', '', n)));
  const counting = m.install_in != null;
  $('#upd-bar').hidden = m.state !== 'downloading' && !counting;
  $('#upd-bar > div').style.width = counting
    ? `${Math.round(((installTotal - m.install_in) / installTotal) * 100)}%` : `${m.progress}%`;

  const resume = updMode === 'resume';
  const workingNote = resume ? txt('settings.update.note.resume')
    : working ? txt('settings.update.note.working', { n: working }) : txt('settings.update.note.idle');
  const state = counting
    ? txt('settings.update.state.counting', { n: m.install_in })
    : m.when_idle
    ? (m.state === 'downloading' ? txt('settings.update.state.downloading_prefix', { p: m.progress }) : '')
      + (m.resume ? txt('settings.update.state.resume_install')
        : working ? txt('settings.update.state.working_install', { n: working }) : txt('settings.update.state.soon_install'))
    : {
      checking: txt('settings.update.state.checking'),
      downloading: txt('settings.update.state.downloading', { p: m.progress }),
      ready: m.on_exit ? txt('settings.update.state.on_exit') : txt('settings.update.state.ready', { note: workingNote }),
    }[m.state] || (m.available && m.dev ? txt('settings.update.state.dev') : '');
  const checked = m.checked_at ? txt(Date.now() / 1000 - m.checked_at < 60 ? 'settings.update.checked_now' : 'settings.update.checked_ago', { t: ago(m.checked_at) }) : '';
  $('#upd-state').textContent = [m.required && m.available ? txt('settings.update.state.required') : '', state, checked].filter(Boolean).join(' · ');
  if (m.available && m.latest_channel === 'dev') $('#upd-ver').textContent += txt('settings.update.dev_suffix');
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
    acts.push(btn(txt('settings.update.act.cancel_when_idle'), 'act ghost', () => updAction('cancel_when_idle')));
  } else if (m.available) {
    // Main choice. Resume mode: install as soon as it's downloaded, the tabs open again after.
    // Otherwise wait for the running conversations, then install by itself; with nothing
    // working that is right away (download, then a few seconds of idle).
    acts.push(resume
      ? btn(txt('settings.update.act.now'), 'act', () => {
        if (working && !confirm(txt('settings.update.confirm.resume', { n: working }))) return;
        updAction('install_when_idle');
      })
      : working
      ? btn(txt('settings.update.act.after_working', { n: working }), 'act', () => updAction('install_when_idle'))
      : btn(txt('settings.update.act.now'), 'act', () => {
        if (tabs && !confirm(txt('settings.update.confirm.tabs', { n: tabs }))) return;
        updAction('install_when_idle');
      }));
    if (m.state === 'ready') {
      const cut = resume ? 0 : working;
      if (cut) acts.push(btn(txt('settings.update.act.install_now'), 'act ghost', () => {
        if (!confirm(txt('settings.update.confirm.cut', { n: cut }))) return;
        updAction('install_now');
      }));
      acts.push(m.on_exit
        ? btn(txt('settings.update.act.cancel_on_exit'), 'act ghost', () => updAction('cancel_on_exit'))
        : btn(txt('settings.update.act.install_on_exit'), 'act ghost', () => updAction('install_on_exit')));
    } else {
      acts.push(btn(txt('settings.update.act.download'), 'act ghost', () => updAction('download'), busy));
    }
  }
  acts.push(btn(txt('settings.update.act.check'), 'act ghost', () => updAction('check'), busy));
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
  // Links open in this PC's browser from the desktop window only (other devices open their own).
  $('#link-browser-row').hidden = !isDesktop || p2pMode || !m.link_browser;
  if (m.link_browser) $('#link-browser').value = m.link_browser;
  if (Array.isArray(m.top_bar)) { topBar = m.top_bar; applyTopBar(); renderBarSet(); }
  themePresets = Array.isArray(m.theme_presets) ? m.theme_presets : [];
  setThemeViews(m.themes);
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
$('#link-browser').onchange = (e) => send({ t: 'link_browser', browser: e.target.value });

// ---- theme colors: three per theme, the rest derived on the PC (theme.rs) ----
/** @type {{id:string, name:string, mode:string, bg:string, fg:string, accent:string}[]} */
let themePresets = [];
const THEME_FIELDS = [['bg', 'settings.theme.bg'], ['fg', 'settings.theme.fg'], ['accent', 'settings.theme.accent']];
const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
let themeSendTimer = 0;
/** Sends one theme's colors (null = its default preset); `soon` waits a moment (dragging in a picker). */
function sendThemeColors(mode, colors, soon) {
  clearTimeout(themeSendTimer);
  const go = () => send({ t: 'theme_colors', mode, colors });
  if (soon) themeSendTimer = setTimeout(go, 150); else go();
}
function themeCard(mode) {
  const card = document.createElement('div');
  card.className = 'tcard';
  card.dataset.mode = mode;
  card.innerHTML = `<h3>${mode === 'dark' ? txt('settings.theme.dark') : txt('settings.theme.light')}</h3><div class="tbox">
    <div class="trow"><span class="tname">${txt('settings.theme.preset')}</span>
      <button type="button" class="icon treset" title="${txt('settings.theme.reset')}">↺</button><select class="tpreset"></select></div>
    ${THEME_FIELDS.map(([k, id]) => { const name = txt(id); return `<div class="trow"><span class="tname">${name}</span>
      <label class="tcolor"><input type="color" data-k="${k}" aria-label="${txt('settings.theme.pick', { name })}"><span class="thash">#</span>
      <input type="text" data-k="${k}" maxlength="7" spellcheck="false" aria-label="${txt('settings.theme.hex', { name })}"></label></div>`; }).join('')}
  </div>`;
  const view = () => themeViews?.find((t) => t.mode === mode);
  /** The card's three colors with `k` changed to `v`. */
  const withColor = (k, v) => ({ ...view().colors, [k]: v });
  card.querySelector('.treset').onclick = () => sendThemeColors(mode, null);
  card.querySelector('.tpreset').onchange = (e) => {
    const p = themePresets.find((p) => p.id === e.target.value);
    if (p) sendThemeColors(mode, { bg: p.bg, fg: p.fg, accent: p.accent });
  };
  for (const inp of card.querySelectorAll('input[type="color"]')) {
    const k = inp.dataset.k;
    inp.oninput = () => {
      card.querySelector(`input[type="text"][data-k="${k}"]`).value = inp.value.slice(1);
      sendThemeColors(mode, withColor(k, inp.value), true);
    };
    inp.onchange = () => sendThemeColors(mode, withColor(k, inp.value));
  }
  for (const inp of card.querySelectorAll('input[type="text"]')) {
    const k = inp.dataset.k;
    inp.onchange = () => {
      const m = HEX.exec(inp.value.trim());
      if (!m) { renderThemeColors(true); return; } // not a color: back to the saved one
      const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
      sendThemeColors(mode, withColor(k, '#' + h.toLowerCase()));
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
  }
  return card;
}
/** Fills the cards from the PC's themes. `force` also rewrites the field being typed in. */
function renderThemeColors(force) {
  const box = $('#theme-cards');
  $('#color-set').hidden = !isDesktop || p2pMode || !themeViews;
  if (!themeViews) return;
  if (!box.children.length) for (const t of themeViews) box.append(themeCard(t.mode));
  for (const card of box.children) {
    const t = themeViews.find((t) => t.mode === card.dataset.mode);
    if (!t) continue;
    const presets = themePresets.filter((p) => p.mode === t.mode);
    const sel = card.querySelector('.tpreset');
    sel.replaceChildren(...presets.map((p) => new Option(p.name, p.id)));
    if (!t.preset) sel.append(Object.assign(new Option(txt('settings.theme.custom'), ''), { disabled: true }));
    sel.value = t.preset || '';
    card.querySelector('.treset').disabled = !presets.length || t.preset === presets[0].id;
    for (const [k] of THEME_FIELDS) {
      const c = card.querySelector(`input[type="color"][data-k="${k}"]`);
      const x = card.querySelector(`input[type="text"][data-k="${k}"]`);
      // Leave a field alone while it's being edited (its picker is open, or it's being typed in).
      if (force || document.activeElement !== c) c.value = t.colors[k];
      if (force || document.activeElement !== x) x.value = t.colors[k].slice(1);
    }
  }
}
// After THEME_FIELDS and themePresets exist: with themes cached from the last run this already
// draws the cards, and an error here would stop the rest of this file (the settings button with it).
renderThemePane();

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
    sw.title = s.required ? txt('settings.bar.locked') : (s.shown ? txt('settings.bar.hide') : txt('settings.bar.show'));
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: s.shown, disabled: s.required });
    cb.onchange = () => sendTopBar(topBar.map((o, j) => (j === i ? { ...o, shown: cb.checked } : o)));
    sw.append(cb, document.createElement('span'));
    const name = Object.assign(document.createElement('span'), { className: 'bar-name', textContent: s.label });
    const move = (d) => {
      const l = topBar.slice();
      [l[i], l[i + d]] = [l[i + d], l[i]];
      sendTopBar(l);
    };
    const up = Object.assign(document.createElement('button'), { type: 'button', className: 'icon', textContent: '↑', title: txt('settings.bar.up'), disabled: i === 0 });
    const down = Object.assign(document.createElement('button'), { type: 'button', className: 'icon', textContent: '↓', title: txt('settings.bar.down'), disabled: i === topBar.length - 1 });
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
  $('#remote-btn').title = txt('remote.tip.none');
  $('#remote-btn').onclick = () => (paneOpen('remote') ? closeSettings() : openSettings('remote'));
} else {
  $('#remote-btn').classList.add('just-dot');
  $('#remote-btn').tabIndex = -1;
}
function showConn(on) {
  if (localDesk) return;
  $('#conn').className = on ? 'dot on' : 'dot off';
  $('#remote-btn').title = on ? txt('conn.tip.on') : txt('conn.tip.off');
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
    $('#pair-ttl').textContent = left ? txt('settings.pair.ttl', { t: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` }) : txt('settings.pair.expired');
    if (!left) { clearInterval(pairTimer); $('#pair-box').hidden = true; }
  };
  tick();
  pairTimer = setInterval(tick, 1000);
}

// ---- relay (TURN) key: settings › remote, desktop window only ----
let turnOn = false;   // a key is set (remote status `turn`)
let turnAsked = '';   // 'save' | 'clear' while waiting for turn_done
function turnState() {
  $('#turn-state').textContent = turnAsked === 'save' ? txt('settings.turn.checking')
    : turnOn ? txt('settings.turn.on')
    : txt('settings.turn.off');
  $('#turn-clear').hidden = !turnOn;
  $('#turn-save').textContent = turnOn ? txt('settings.turn.change') : txt('settings.turn.save');
  $('#turn-save').disabled = !!turnAsked;
}
$('#turn-form').onsubmit = (e) => {
  e.preventDefault();
  const id = $('#turn-id').value.trim();
  const token = $('#turn-token').value.trim();
  if (!id || !token) { toast(txt('settings.turn.need_both')); return; }
  turnAsked = 'save';
  turnState();
  send({ t: 'turn', id, token });
};
$('#turn-clear').onclick = () => {
  if (!confirm(txt('settings.turn.confirm_clear'))) return;
  turnAsked = 'clear';
  send({ t: 'turn', id: '', token: '' });
};
function onTurnDone(m) {
  const was = turnAsked;
  turnAsked = '';
  turnState();
  if (m.error) { toast(m.error, 6000); return; }
  $('#turn-id').value = '';
  $('#turn-token').value = '';
  toast(was === 'clear' ? txt('settings.turn.cleared') : txt('settings.turn.enabled'), 5000);
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
