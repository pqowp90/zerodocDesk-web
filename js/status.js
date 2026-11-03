// DeskDoc web client: plan usage, chat / command view switch, the active tab's state and Claude account.
'use strict';

// ---- Claude plan usage (status bar across the window bottom) ----
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
// "이 대화" numbers (context, share of the limits) can be turned off in settings.
let chatUsageOn = load('zd-chat-usage') !== '0';
const pctOf = (x) => Math.max(0, Math.min(100, Math.round(x)));
/** "used / max" in one unit, so it reads "89.5k / 1,000k", not "89.5k / 1M". */
function ctxTokens(used, max) {
  const [d, u] = used >= 1e6 ? [1e6, 'M'] : max >= 1000 ? [1000, 'k'] : [1, ''];
  const f = (n) => (+(n / d).toFixed(d === 1e6 ? 2 : 1)).toLocaleString('en-US') + u;
  return `${f(used)} / ${f(max)}`;
}
/** A share of a limit in points: small ones keep a decimal so they don't all read 0%. */
const shareText = (x) => (x > 0 && x < 9.95 ? x.toFixed(1) : Math.round(x)) + '%';
const warnClass = (p) => (p >= 90 ? ' bad' : p >= 70 ? ' warn' : '');
/** Status bar item: "5h ▮ N%". */
function usageItem(name, pct) {
  const p = pctOf(pct);
  const span = document.createElement('span');
  span.className = 'u-item' + warnClass(p);
  const bar = document.createElement('i');
  bar.style.setProperty('--p', p + '%');
  span.append(name + ' ', bar, ' ' + p + '%');
  return span;
}
/** Input box: this conversation's share of the limits right of the model picker, its context ring left of send. */
function renderChatUse(ctx, share) {
  const cel = $('#chat-ctx'), sel = $('#chat-share');
  $('#ctx-pick').hidden = !ctx;
  if (ctx) {
    const cp = pctOf((ctx.used / ctx.max) * 100);
    cel.classList.remove('warn', 'bad');
    if (warnClass(cp)) cel.classList.add(warnClass(cp).trim());
    const ring = document.createElement('i');
    ring.style.setProperty('--p', cp + '%');
    cel.replaceChildren(ring, cp + '%');
    cel.title = `컨텍스트 ${cp}% 사용 (${ctxTokens(ctx.used, ctx.max)} 토큰) · 눌러서 지금 요약하기`;
  }
  renderCtxMenu();
  // [short label, name in the tooltip, share]
  const shares = share ? [['5h', '세션', share.session], ['7d', '주간', share.weekly]].filter(([, , x]) => x != null) : [];
  sel.hidden = !shares.length;
  if (shares.length) {
    sel.textContent = shares.map(([l, , x]) => `${l} ${shareText(x)}`).join(' · ');
    sel.title = `이 대화가 쓴 몫: ${shares.map(([, n, x]) => `${n} 한도의 약 ${shareText(x)}`).join(', ')}\n`
      + '이 PC의 Claude Code 기록으로 어림한 값이라 다른 기기 사용분은 몰라요';
  }
}
function renderUsage() {
  const el = $('#usage');
  const s = chatUsageOn && active !== null && sessions.get(active);
  const ctx = s && s.info.claude && s.ctx;
  const share = s && usage && (usage.chats || []).find((c) => c.tab === active);
  renderChatUse(ctx, share);
  // Status bar: the plan's limits, of the active Claude tab's account (an older desktop app
  // sends one account only: the top-level numbers).
  const tab = active !== null && sessions.get(active);
  const u = (tab && tab.info.claude && accountOf(tab)) || usage;
  // [short label on the bar, name in the tooltip, limit]
  const items = u ? [
    ['5h', '세션(5시간)', u.session],
    ['7d', '주간(7일)', u.weekly],
  ].filter(([, , l]) => l) : [];
  // Per-model weekly limits (e.g. Fable), counted apart from the all-models one: tooltip only, not on the bar.
  const scoped = u ? (u.scoped || []).map((l) => [l.name, `${l.name}(7일)`, l]) : [];
  el.hidden = !items.length;
  if (el.hidden) return;
  el.replaceChildren(...items.map(([label, , l]) => usageItem(label, l.pct)));
  const lines = [];
  for (const [, name, l] of [...items, ...scoped]) {
    const r = l.resets_at ? ` · ${untilText(l.resets_at)} 초기화 (${whenText(l.resets_at)})` : '';
    lines.push(`${name} ${Math.round(l.pct)}% 사용${r}`);
  }
  if (u && u.plan) lines.push(`플랜: ${u.plan}`);
  if (usage) lines.push('클릭하면 지금 다시 확인해요');
  el.title = lines.join('\n');
}
// A login finishing turns the tab's chat back on: syncChat looks at the accounts too.
function onUsage(m) {
  const sw = m.auto_switch;
  const seen = usage && usage.auto_switch;
  usage = m;
  syncChat();
  renderAccount();
  // A tab moved to another account on its own: say so once (not for one from before this page opened).
  if (sw && (!seen || seen.at !== sw.at || seen.tab !== sw.tab) && Date.now() / 1000 - sw.at < 120) {
    const to = accountsList().find((a) => a.id === sw.to);
    const tab = sessions.get(sw.tab);
    toast(`사용량 한도에 닿아서 ${tab ? `'${tab.info.title}' 탭을 ` : ''}${to ? accountName(to) : sw.to} 계정으로 바꿔 이어서 해요`, 8000);
  }
}
$('#usage').addEventListener('click', () => send({ t: 'usage' }));
$('#chat-usage').checked = chatUsageOn;
$('#chat-usage').onchange = (e) => { chatUsageOn = e.target.checked; store('zd-chat-usage', chatUsageOn ? undefined : '0'); renderUsage(); };
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
  return !!(chatPref && !chatUnsupported && s && s.info.claude && s.info.alive && !menuNeedsTerm && !needsLogin(s));
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
  renderUsage(); // the context and "이 대화" numbers belong to the active tab
  renderTabState();
  renderAccount();
}

// ---- active tab's state (status bar, bottom left) ----
/** "now", "3m", "14h", "2d": how long a state has lasted, in its largest unit only. */
function lastedText(sec) {
  if (sec < 60) return 'now';
  const min = Math.floor(sec / 60), h = Math.floor(min / 60);
  if (h < 1) return `${min}m`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function renderTabState() {
  const el = $('#tab-state');
  const s = active !== null && sessions.get(active);
  // Shells have no working/idle state; an older desktop app sends no `since`.
  const known = s && (s.info.claude || !s.info.alive);
  el.hidden = !known;
  if (!known) return;
  const i = s.info;
  const [cls, label] = !i.alive ? ['off', 'Exited'] : i.asking ? ['ask', 'Needs input'] : i.busy ? ['busy', 'Working'] : ['idle', 'Idle'];
  el.className = cls;
  const dot = el.querySelector('i') || document.createElement('i');
  const lasted = i.since ? Math.max(0, Date.now() / 1000 - i.since) : null;
  el.replaceChildren(dot, lasted === null ? label : `${label} · ${lastedText(lasted)}`);
  el.title = lasted === null ? label
    : `${label} since ${new Date(i.since * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}
setInterval(renderTabState, 15000); // the "Nm" count

// ---- Claude account of the active tab (status bar, right of its state) ----
// Each Claude tab runs as one account; picking another restarts that tab's Claude on the same
// conversation (the server does it). The usage message lists every account with its limits.
const acctMenu = el('div', 'conv-menu acct-menu');
acctMenu.hidden = true;
document.body.append(acctMenu);
function accountsList() { return (usage && usage.accounts) || []; }
function tabAccount(s) { return (s && s.info.account) || 'default'; }
function accountOf(s) { return accountsList().find((a) => a.id === tabAccount(s)); }
function accountName(a) { return a.email || a.id; }
/** A tab whose account isn't logged in: its terminal shows Claude's login, so the chat stays off. */
function needsLogin(s) { const a = accountOf(s); return !!(a && !a.signed_in); }
/** "4h9m", "2d6h", "37m": time until `iso`. */
function leftShort(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return '곧';
  const min = Math.round(ms / 60000), h = Math.floor(min / 60), d = Math.floor(h / 24);
  if (d >= 1) return `${d}d${h % 24}h`;
  if (h >= 1) return `${h}h${min % 60}m`;
  return `${Math.max(1, min)}m`;
}
function renderAccount() {
  const b = $('#account');
  const s = active !== null && sessions.get(active);
  const a = s && s.info.claude && s.info.alive && accountOf(s);
  b.hidden = !a;
  if (b.hidden) { if (!acctMenu.hidden) closeAccountMenu(); return; }
  b.textContent = a.signed_in ? accountName(a).split('@')[0] : `${a.id} (로그인 안 됨)`;
  b.classList.toggle('warn', !a.signed_in);
  b.title = `${accountName(a)}${planOf(a) ? ' · ' + planOf(a) : ''}\n누르면 이 탭의 계정을 바꿔요`;
  if (!acctMenu.hidden) fillAccountMenu();
}
/** "Claude Max 5x" (the server names it; an older desktop app sends only `plan`: "max"). */
const planOf = (a) => a.plan_name || (a.plan ? 'Claude ' + a.plan.charAt(0).toUpperCase() + a.plan.slice(1) : '');
/** "5h ▬ 4% 4h9m": one limit in an account row. */
function acctLimit(label, l) {
  const span = el('span', 'al');
  if (!l) { span.append(label + ' ', el('i'), ' --'); return span; }
  const p = pctOf(l.pct);
  span.className += warnClass(p);
  const bar = el('i');
  bar.style.setProperty('--p', p + '%');
  span.append(label + ' ', bar, ` ${p}%`, el('span', 'al-left', l.resets_at ? leftShort(l.resets_at) : ''));
  return span;
}
function fillAccountMenu() {
  const s = active !== null && sessions.get(active);
  const cur = tabAccount(s);
  const rows = accountsList().map((a) => {
    const row = el('button', 'cm-i acct-row' + (a.id === cur ? ' on' : ''));
    row.type = 'button';
    const check = el('span', 'cm-ic', a.id === cur ? '✓' : '');
    const main = el('span', 'acct-main');
    const name = el('span', 'acct-name', a.signed_in ? accountName(a) : `${a.id} (로그인 안 됨)`);
    if (a.signed_in && planOf(a)) name.append(el('span', 'acct-plan', ` · ${planOf(a)}`));
    const use = el('span', 'acct-use');
    use.append(acctLimit('5h', a.session), acctLimit('7d', a.weekly));
    main.append(name, use);
    row.append(check, main);
    // "자동": this account takes part in moving tabs on its own at a limit (an older desktop app sends none).
    if (a.auto !== undefined) {
      const auto = el('span', 'acct-auto' + (a.auto ? ' on' : ''), '자동');
      auto.setAttribute('role', 'switch');
      auto.setAttribute('aria-checked', a.auto ? 'true' : 'false');
      auto.title = a.auto
        ? '자동 켜짐: 한도에 닿으면 탭이 여유 있는 다른 계정으로 넘어가 이어서 해요. 누르면 꺼요.'
        : '자동 꺼짐: 이 계정은 한도에 닿아도 그대로 있고, 다른 계정 탭도 이리로 넘어오지 않아요. 누르면 켜요.';
      auto.onclick = (e) => { e.stopPropagation(); send({ t: 'account_auto', account: a.id, on: !a.auto }); };
      row.append(auto);
    }
    row.onclick = (e) => {
      e.stopPropagation();
      closeAccountMenu();
      if (a.id !== cur && s) { send({ t: 'account', id: s.id, account: a.id }); toast(`이 탭을 ${accountName(a)} 계정으로 바꾸는 중…`, 2500); }
    };
    return row;
  });
  const add = menuItem('', '새 계정 추가', '', () => {
    closeAccountMenu();
    const ref = active !== null && sessions.get(active);
    const claudeTab = ref && ref.info.claude && ref.info.alive;
    if (!claudeTab) wantActivate++;
    send({ t: 'account_add', tab: claudeTab ? ref.id : null, cols: ref ? ref.term.cols : 120, rows: ref ? ref.term.rows : 30 });
  });
  add.querySelector('.cm-ic').textContent = '+';
  acctMenu.replaceChildren(...rows, el('div', 'cm-sep'), add);
}
function openAccountMenu() {
  if (!acctMenu.hidden) { closeAccountMenu(); return; }
  send({ t: 'usage' }); // fresh numbers for every account
  fillAccountMenu();
  acctMenu.hidden = false;
  $('#account').classList.add('open');
  const r = $('#account').getBoundingClientRect();
  acctMenu.style.left = Math.max(8, Math.min(r.left, innerWidth - acctMenu.offsetWidth - 8)) + 'px';
  acctMenu.style.top = Math.max(8, r.top - acctMenu.offsetHeight - 4) + 'px';
}
function closeAccountMenu() {
  acctMenu.hidden = true;
  $('#account').classList.remove('open');
}
$('#account').addEventListener('click', openAccountMenu);
document.addEventListener('pointerdown', (e) => { if (!acctMenu.hidden && !e.target.closest('.acct-menu, #account')) closeAccountMenu(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !acctMenu.hidden) { e.preventDefault(); e.stopPropagation(); closeAccountMenu(); } }, true);
addEventListener('resize', closeAccountMenu);
function onAccountDone(m) {
  if (m.error) toast(m.error, 6000);
  else if (m.added) toast('새 계정에 로그인해 주세요. 브라우저가 열려요.', 6000);
}
