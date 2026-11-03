// DeskDoc web client: connection to the desktop app, pairing, the installable app.
'use strict';

// ---- connection ----
function showEmpty(text) {
  $('#terms .empty')?.remove();
  $('#terms').append(Object.assign(document.createElement('div'), { className: 'empty', textContent: text }));
}

function connect() {
  if (p2pMode) {
    if (!desk) { showUnpaired(); return; }
    if (!sessions.size) showEmpty('데스크탑에 연결하는 중…');
    // On the hosted page the loader fetched this screen over a connection: take that one over (once).
    ws = (window.ZDBOOT && ZDBOOT.take()) || ZDP2P.connect(desk.pub, desk.relays);
    ws.onstatus = (s) => { if (!sessions.size) showEmpty(s); };
  } else {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.binaryType = 'arraybuffer';
  }
  const sock = ws;
  ws.onopen = () => {
    retry = p2pMode ? 2000 : 500;
    showConn(true);
    if (p2pMode) toast('데스크탑에 연결됐어요', 2000);
    // Re-attach everything we already show: output during the gap is in the server's scrollback.
    for (const s of sessions.values()) send({ t: 'attach', id: s.id });
    if (!document.body.classList.contains('side-hidden')) send({ t: 'projects' });
    watching = undefined; // the server forgot what we watched: ask again
    syncChat(true);
    syncWindowTheme();
    // Hosted page, reconnected: the desktop may have been updated meanwhile. Its screen then
    // differs from this one, and the loader reloads into the new one ({t:"webui"} below).
    if (window.ZDBOOT && ZDBOOT.hash && sock.reconnected) send({ t: 'webui', have: ZDBOOT.hash });
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return onFrame(ev.data);
    const m = JSON.parse(ev.data);
    if (m.t === 'sessions') onSessions(m.list);
    else if (m.t === 'live') onLive(m);
    else if (m.t === 'remote') onRemote(m);
    else if (m.t === 'pairing') onPairing(m);
    else if (m.t === 'uploaded') onUploaded(m);
    else if (m.t === 'folder') onFolder(m);
    else if (m.t === 'update') onUpdate(m);
    else if (m.t === 'usage') onUsage(m);
    else if (m.t === 'prefs') onPrefs(m);
    else if (m.t === 'show') onShow(m);
    else if (m.t === 'button_done') onButtonDone(m);
    else if (m.t === 'conv_done') onConvDone(m);
    else if (m.t === 'account_done') onAccountDone(m);
    else if (m.t === 'mode_done') onModeDone(m);
    else if (m.t === 'compact_done') onCompactDone(m);
    else if (m.t === 'projects') {
      projects = m.list; renderProjects(); adoptDrafts();
      if (paneOpen('skills')) { const had = skCwd; renderSkillScope(); if (skScope === 'local' && !had && skCwd) skRequest(); }
    }
    else if (m.t === 'chat') onChat(m);
    else if (m.t === 'skills') onSkills(m);
    else if (m.t === 'complete') onComplete(m);
    else if (m.t === 'skill_done') onSkillDone(m);
    // An older desktop app without the chat stream: stay on the terminal.
    else if (m.t === 'file') onFile(m);
    else if (m.t === 'webui') window.ZDBOOT?.onWebui(m);
    else if (m.t === 'turn_done') onTurnDone(m);
    else if (m.t === 'error' && /variant `webui`/.test(m.msg)) {} // an older desktop app: keep this screen
    // An older desktop app doesn't know these messages (the rejection lists every message it
    // does know, so match the unknown one's own name).
    else if (m.t === 'error' && /variant `complete`/.test(m.msg)) { acOff = true; acClose(); }
    else if (m.t === 'error' && /variant `watch`/.test(m.msg)) { chatUnsupported = true; syncChat(true); }
    else if (m.t === 'error' && /variant `(conv_rename|conv_delete|proj_move)`/.test(m.msg)) { toast('데스크탑 앱을 업데이트하면 쓸 수 있어요'); send({ t: 'projects' }); }
    else if (m.t === 'error' && /variant `compact`/.test(m.msg)) onCompactDone({ error: '데스크탑 앱을 업데이트하면 쓸 수 있어요' });
    else if (m.t === 'error' && /variant `(file|reveal)`/.test(m.msg)) {
      for (const [rid, r] of fileReqs) { fileReqs.delete(rid); clearTimeout(r.timer); r.reject(new Error('데스크탑 앱을 업데이트하면 볼 수 있어요')); }
    }
    else if (m.t === 'error') toast(m.msg);
  };
  ws.onclose = (ev) => {
    showConn(false);
    for (const b of document.querySelectorAll('.ubtn.busy')) b.classList.remove('busy'); // its answer is lost
    if (sock.lastError && sock.lastError.denied) {
      window.ZDBOOT?.forget(desk.pub);
      store('zd-desk', ''); desk = null;
      showEmpty(sock.lastError.message);
      return;
    }
    if (p2pMode && ev && ev.reason && ev.reason !== 'channel closed') {
      toast(`${ev.reason} · ${Math.round(retry / 1000)}초 뒤 다시 시도`, retry);
    }
    setTimeout(connect, retry);
    // P2P retries cost relay round-trips: back off further.
    retry = Math.min(retry * 2, p2pMode ? 30000 : 5000);
  };
  if (sock.taken) {
    // Already open (handed over by the loader): what arrived meanwhile comes now, after `onopen`.
    sock.onopen();
    sock.replay();
  } else sock.reconnected = connected;
  connected = true;
}
let connected = false; // a connection was open before (the next one is a reconnect)

// ---- pairing and the installable app (hosted page only) ----
const hosted = p2pMode && !isDesktop;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = window.ZDBOOT?.installPrompt || null; // Chrome's deferred install offer (the loader may have caught it)
let pairError = '';       // why the last pairing failed, shown on the "not paired" screen

/**
 * Pairs with the desktop from link params (returns an error message, or '' on success):
 * the desktop's QR `d=<desk pubkey>&s=<secret>&r=<relays>`, or a move link
 * `k=<this device's key>&d=&r=` made by the move button below.
 */
async function pairWith(p) {
  const d = p.get('d');
  const s = p.get('s');
  const k = p.get('k');
  const relays = (p.get('r') || '').split(',').filter(Boolean);
  const hex = /^[0-9a-f]{64}$/;
  if (!d || !hex.test(d) || !(s || k)) return '링크가 올바르지 않아요';
  if (k) {
    // An iPhone home-screen app doesn't share Safari's storage: take over the key Safari paired with.
    if (!hex.test(k)) return '링크가 올바르지 않아요';
    store('zd-sk', k);
    desk = { pub: d, relays };
    store('zd-desk', JSON.stringify(desk));
    return '';
  }
  showEmpty('데스크탑과 짝을 맺는 중…');
  try {
    if (!(await ZDP2P.pair(d, relays, s))) return 'QR이 만료됐거나 이미 사용됐어요. 데스크탑에서 새 QR을 만들어 주세요.';
  } catch (e) {
    return e.message;
  }
  desk = { pub: d, relays };
  store('zd-desk', JSON.stringify(desk));
  return '';
}

function pairedToast(moved) {
  if (moved) toast('연결을 옮겼어요', 4000);
  else toast(hosted && !standalone ? '짝 맺기 완료! [설정] → [화면]에서 앱으로 설치해 두면 편해요' : '짝 맺기 완료!', 5000);
}

/** Opened from the desktop's pairing QR, or from a move link. */
async function pairFromHash() {
  if (!hash.get('d')) return;
  history.replaceState(null, '', location.pathname + location.search);
  pairError = await pairWith(hash);
  if (!pairError) pairedToast(hash.has('k'));
  else if (desk) toast(pairError, 6000); // still paired from before: say it, then connect as usual
  renderInstall();
}

/**
 * Not paired yet. In the browser the camera's QR link opens this page; an installed app can't be
 * opened that way, so it takes the link by paste.
 */
function showUnpaired() {
  const qrHelp = '데스크탑 앱의 [설정] → [리모트] → "새 기기 연결 QR"을 이 기기로 찍어 주세요';
  if (!standalone) { showEmpty(pairError ? `${pairError}\n\n${qrHelp}` : qrHelp); return; }
  showEmpty('');
  const el = $('#terms .empty');
  const box = Object.assign(document.createElement('form'), { className: 'paste-pair' });
  const msg = Object.assign(document.createElement('p'), {
    textContent: iOS
      ? 'Safari에서 짝을 맺었다면 Safari의 [설정] → [화면] → "홈 화면 앱으로 연결 옮기기"로 복사한 링크를 붙여넣어 주세요.\n처음이라면 데스크탑 QR을 카메라로 찍어 Safari에서 먼저 짝을 맺어 주세요.'
      : '데스크탑 QR을 카메라로 찍거나, 복사한 연결 링크를 붙여넣어 주세요.',
  });
  const err = Object.assign(document.createElement('p'), { className: 'paste-err', textContent: pairError });
  const input = Object.assign(document.createElement('input'), { type: 'url', placeholder: 'https://… 링크 붙여넣기', autocomplete: 'off' });
  const ok = Object.assign(document.createElement('button'), { type: 'submit', className: 'act', textContent: '연결' });
  box.append(msg, err, input, ok);
  el.append(box);
  box.onsubmit = async (e) => {
    e.preventDefault();
    let p;
    try { p = new URLSearchParams(new URL(input.value.trim()).hash.slice(1)); } catch { p = new URLSearchParams(); }
    pairError = await pairWith(p);
    if (pairError) { showUnpaired(); return; }
    pairedToast(p.has('k'));
    renderInstall();
    connect();
  };
}

if (hosted && 'serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; renderInstall(); });
addEventListener('appinstalled', () => { installPrompt = null; renderInstall(); });

function renderInstall() {
  $('#install-set').hidden = !hosted;
  if (!hosted) return;
  const canMove = iOS && !standalone && !!desk;
  $('#install-btn').hidden = !installPrompt;
  $('#move-btn').hidden = !canMove;
  let hint;
  if (standalone) hint = '지금 앱으로 실행 중이에요.';
  else if (installPrompt) hint = '설치하면 홈 화면 아이콘으로 주소창 없이 앱처럼 열려요.';
  else if (iOS) {
    hint = 'Safari 아래쪽 공유 버튼 → [홈 화면에 추가]로 앱처럼 설치할 수 있어요.';
    if (canMove) hint += ' iPhone에서는 설치한 앱이 Safari와 저장 공간을 따로 써서 처음엔 연결이 비어 있어요. 아래 버튼으로 연결 링크를 복사한 뒤, 홈 화면의 DeskDoc을 열어 붙여넣으세요. 이 링크는 이 기기의 열쇠라 남에게 보내면 안 돼요.';
  } else hint = '브라우저 메뉴의 [앱 설치] 또는 [홈 화면에 추가]로 앱처럼 설치할 수 있어요.';
  $('#install-hint').textContent = hint;
}
renderInstall();

$('#install-btn').onclick = async () => {
  if (!installPrompt) return;
  const p = installPrompt;
  installPrompt = null;
  try { await p.prompt(); await p.userChoice; } catch {}
  renderInstall();
};

$('#move-btn').onclick = async () => {
  const sk = load('zd-sk');
  if (!sk || !desk) return;
  const link = `${location.origin}${location.pathname}#k=${sk}&d=${desk.pub}&r=${desk.relays.join(',')}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('연결 링크를 복사했어요. 홈 화면의 DeskDoc을 열고 붙여넣으세요', 6000);
  } catch {
    prompt('이 링크를 복사해 주세요', link);
  }
};
