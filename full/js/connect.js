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
    if (!sessions.size) showEmpty(txt('connect.connecting'));
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
    if (p2pMode) toast(txt('connect.connected'), 2000);
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
    else if (m.t === 'prefs') { onPrefs(m); if (Array.isArray(m.keys)) onKeys(m.keys); }
    else if (m.t === 'key_done') onKeyDone(m);
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
    else if (m.t === 'error' && /variant `(conv_rename|conv_delete|proj_move)`/.test(m.msg)) { toast(txt('connect.old_app.use')); send({ t: 'projects' }); }
    else if (m.t === 'error' && /variant `compact`/.test(m.msg)) onCompactDone({ error: txt('connect.old_app.use') });
    else if (m.t === 'error' && /variant `(file|reveal)`/.test(m.msg)) {
      for (const [rid, r] of fileReqs) { fileReqs.delete(rid); clearTimeout(r.timer); r.reject(new Error(txt('connect.old_app.view'))); }
    }
    else if (m.t === 'error') toast(errText(m));
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
      toast(txt('connect.retry', { reason: ev.reason, n: Math.round(retry / 1000) }), retry);
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
  if (!d || !hex.test(d) || !(s || k)) return txt('connect.bad_link');
  if (k) {
    // An iPhone home-screen app doesn't share Safari's storage: take over the key Safari paired with.
    if (!hex.test(k)) return txt('connect.bad_link');
    store('zd-sk', k);
    desk = { pub: d, relays };
    store('zd-desk', JSON.stringify(desk));
    return '';
  }
  showEmpty(txt('connect.pairing'));
  try {
    if (!(await ZDP2P.pair(d, relays, s))) return txt('connect.qr_expired');
  } catch (e) {
    return e.message;
  }
  desk = { pub: d, relays };
  store('zd-desk', JSON.stringify(desk));
  return '';
}

function pairedToast(moved) {
  if (moved) toast(txt('connect.moved'), 4000);
  else toast(hosted && !standalone ? txt('connect.paired_install') : txt('connect.paired'), 5000);
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
  const qrHelp = txt('connect.qr_help');
  if (!standalone) { showEmpty(pairError ? `${pairError}\n\n${qrHelp}` : qrHelp); return; }
  showEmpty('');
  const el = $('#terms .empty');
  const box = Object.assign(document.createElement('form'), { className: 'paste-pair' });
  const msg = Object.assign(document.createElement('p'), {
    textContent: iOS
      ? txt('connect.paste.ios')
      : txt('connect.paste.other'),
  });
  const err = Object.assign(document.createElement('p'), { className: 'paste-err', textContent: pairError });
  const input = Object.assign(document.createElement('input'), { type: 'url', placeholder: txt('connect.paste.ph'), autocomplete: 'off' });
  const ok = Object.assign(document.createElement('button'), { type: 'submit', className: 'act', textContent: txt('connect.paste.submit') });
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
  if (standalone) hint = txt('connect.install.standalone');
  else if (installPrompt) hint = txt('connect.install.prompt');
  else if (iOS) {
    hint = txt('connect.install.ios');
    if (canMove) hint += txt('connect.install.ios_move');
  } else hint = txt('connect.install.other');
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
    toast(txt('connect.link_copied'), 6000);
  } catch {
    prompt(txt('connect.link_prompt'), link);
  }
};
