// DeskDoc web client: "Claude finished" notifications, the tab list from the server, remote access state.
'use strict';

// ---- messages ----
// ---- "Claude finished" notifications ----
// Asked on the first click/key (browsers only allow the prompt after a user gesture).
// Not in the desktop window: there the app shows Windows notifications itself (settings › 알림).
const canNotify = typeof Notification !== 'undefined' && !(isDesktop && !p2pMode);
addEventListener('pointerdown', () => {
  if (canNotify && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}, { once: true });

/** A Claude tab went from working to idle. Quiet if you are already looking at that tab. */
function notifyDone(s) {
  const watching = s.id === active && document.hasFocus();
  if (watching) return;
  s.unread = true;
  s.done = true; // blue dot in the sidebar until you open it
  const name = (s.osTitle || s.info.title).replace(/^[⠀-⣿✳*·\s]+/, '').slice(0, 40) || 'Claude';
  toast(`✓ ${name} 작업이 끝났어요`, 6000);
  const t = $('#toast');
  t.onclick = () => { activate(s.id); t.hidden = true; };
  if (canNotify && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
    try {
      const n = new Notification('작업 끝남', { body: name, tag: `zd-${s.id}` });
      n.onclick = () => { focus(); activate(s.id); n.close(); };
    } catch {}
  }
}

// Back in the window: the tab on screen that finished meanwhile has now been seen.
addEventListener('focus', () => {
  const s = active !== null && sessions.get(active);
  if (!s || !s.done) return;
  s.done = false;
  s.unread = false;
  if (projects.length) renderProjects();
});

/** Projects list refresh, coalesced (tab opened/closed, or a conversation just got written). */
let projTimer = 0;
function refreshProjectsSoon() {
  if (document.body.classList.contains('side-hidden')) return;
  clearTimeout(projTimer);
  projTimer = setTimeout(() => send({ t: 'projects' }), 800);
}

function onSessions(list) {
  draftsReady = true;
  const seen = new Set();
  let created = null;
  let refresh = false;
  for (const info of list) {
    seen.add(info.id);
    const s = sessions.get(info.id);
    if (s) {
      const was = s.info.busy;
      const resized = s.info.cols !== info.cols || s.info.rows !== info.rows;
      if (!info.asking && termPeek === info.id) termPeek = null; // the menu is answered: back to the chat
      s.info = info;
      if (follow && resized && info.id === active) fitTerm(s);
      if (was && !info.busy) { notifyDone(s); refresh = true; }
      if (!was && info.busy) { s.done = false; refresh = true; } // a new conversation's transcript appears once it starts
    } else { makeSession(info); created = info.id; refresh = true; }
  }
  adoptDrafts(); // before a tab is shown, so its saved text is in the box
  if ([...sessions.keys()].some((id) => !seen.has(id))) refresh = true;
  if (refresh) refreshProjectsSoon();
  if (projects.length) renderProjects();
  syncChat(false); // a menu appeared/went away, or the working state changed
  updateSend();
  flushQueues();
  // A tab we asked for just appeared: switch to it.
  if (created !== null && wantActivate > 0) {
    wantActivate--;
    for (const id of [...sessions.keys()]) if (!seen.has(id)) dropSession(id);
    activate(created);
    return;
  }
  for (const id of [...sessions.keys()]) if (!seen.has(id)) dropSession(id);
  if (active === null || !sessions.has(active)) {
    const last = [...sessions.keys()].pop();
    if (last !== undefined) { activate(last); return; }
  }
  // Desktop window with nothing open: start a Claude tab right away.
  if (!list.length && !autoCreated && isDesktop && !p2pMode) { autoCreated = true; newTab(true); }
  renderTabs();
}

/** Only a tab's live status lines changed: just the working indicator, no list re-render. */
function onLive(m) {
  const s = sessions.get(m.id);
  if (!s) return;
  s.info.live = m.live;
  if (m.id === active) updateChatWorking(s);
}

function onRemote(m) {
  $('#remote-on').checked = m.on;
  const box = $('#remote-urls');
  box.replaceChildren(...m.urls.map((u) => Object.assign(document.createElement('a'), { href: u, textContent: u, target: '_blank' })));
  if (m.on && !m.urls.length) box.textContent = `포트 ${m.port} 에서 대기 중 (LAN IP를 찾지 못했어요)`;

  $('#web-url').textContent = (m.web_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const list = $('#paired');
  list.replaceChildren(...(m.paired || []).map((d) => {
    const row = Object.assign(document.createElement('div'), { className: 'device' });
    const name = Object.assign(document.createElement('span'), { textContent: `📱 ${d.name}` });
    name.title = d.pubkey;
    const del = Object.assign(document.createElement('button'), { textContent: '연결 해제' });
    del.onclick = () => { if (confirm(`${d.name} 의 접속 권한을 지울까요?`)) send({ t: 'unpair', pubkey: d.pubkey }); };
    row.append(name, del);
    return row;
  }));
  $('#peers').textContent = m.peers ? `지금 P2P로 연결된 기기: ${m.peers}대` : '';
  turnOn = !!m.turn;
  turnState();
  if (localDesk) {
    $('#conn').className = m.peers ? 'dot on' : 'dot idle';
    $('#remote-btn').title = m.peers ? `리모트 · 지금 연결된 기기 ${m.peers}대` : '리모트 · 지금 연결된 기기 없음';
  }
  // A device just paired (the QR is single-use): hide it.
  if ((m.paired || []).length > pairedCount && !$('#pair-box').hidden) { $('#pair-box').hidden = true; toast('기기가 연결됐어요'); }
  pairedCount = (m.paired || []).length;
}
