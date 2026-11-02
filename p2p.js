// zerodocDesk P2P transport: Nostr carries the handshake, WebRTC carries the session.
// Exposes window.ZDP2P = { pair, connect } — `connect` returns a WebSocket-like object so the
// rest of the client doesn't care which transport it is on.
'use strict';

(() => {
  const NT = window.NostrTools;
  const KIND = 25871;
  const STUN = 'stun:stun.l.google.com:19302';
  const now = () => Math.floor(Date.now() / 1000);

  function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function store(k, v) { try { localStorage.setItem(k, v); } catch {} }

  /** This device's Nostr key, created once and kept in this origin's storage. */
  function myKey() {
    let hex = load('zd-sk');
    if (!hex) { hex = NT.utils.bytesToHex(NT.generateSecretKey()); store('zd-sk', hex); }
    return NT.utils.hexToBytes(hex);
  }

  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows PC';
    if (/Mac/.test(ua)) return 'Mac';
    return '브라우저';
  }

  /**
   * Sends one encrypted signal to the desktop and waits for the reply `match` accepts.
   * Subscribes first and publishes only once the relays confirmed the subscription:
   * the events are ephemeral, so a reply sent before we listen would be lost.
   */
  function signal(desk, relays, msg, match, timeoutMs) {
    const sk = myKey();
    const pk = NT.getPublicKey(sk);
    const ck = NT.nip44.v2.utils.getConversationKey(sk, desk);
    const pool = new NT.SimplePool();
    return new Promise((resolve, reject) => {
      let done = false;
      let sub = null;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { sub && sub.close(); } catch {}
        setTimeout(() => { try { pool.close(relays); } catch {} }, 100);
        err ? reject(err) : resolve(val);
      };
      const timer = setTimeout(() => finish(new Error('데스크탑이 응답하지 않아요 (앱이 켜져 있는지 확인)')), timeoutMs);
      sub = pool.subscribe(relays, { kinds: [KIND], authors: [desk], '#p': [pk], since: now() - 10 }, {
        maxWait: 4000,
        onevent(ev) {
          try {
            const m = JSON.parse(NT.nip44.v2.decrypt(ev.content, ck));
            if (match(m)) finish(null, m);
          } catch {}
        },
        oneose() {
          const ev = NT.finalizeEvent({
            kind: KIND, created_at: now(), tags: [['p', desk]],
            content: NT.nip44.v2.encrypt(JSON.stringify(msg), ck),
          }, sk);
          Promise.any(pool.publish(relays, ev)).catch(() => finish(new Error('Nostr 릴레이에 연결할 수 없어요')));
        },
      });
    });
  }

  /** One-time pairing with the secret from the desktop's QR. Resolves true when accepted. */
  async function pair(desk, relays, secret) {
    const m = await signal(desk, relays, { type: 'pair', secret, name: deviceName() },
      (m) => m.type === 'paired' || m.type === 'denied', 20000);
    return m.type === 'paired';
  }

  function waitGathering(pc, ms) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); }
      });
    });
  }

  /** WebSocket-shaped connection over a WebRTC data channel. */
  function connect(desk, relays) {
    const sock = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null };
    let pc = null;
    let dc = null;
    let closed = false;
    const fin = (reason) => {
      if (closed) return;
      closed = true;
      sock.readyState = 3;
      try { pc && pc.close(); } catch {}
      sock.onclose && sock.onclose({ reason: reason || '' });
    };
    sock.send = (s) => { if (dc && dc.readyState === 'open') dc.send(s); };
    sock.close = () => fin('closed');

    (async () => {
      pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });
      dc = pc.createDataChannel('zd', { ordered: true });
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => { sock.readyState = 1; sock.onopen && sock.onopen(); };
      dc.onmessage = (e) => sock.onmessage && sock.onmessage({ data: e.data });
      dc.onclose = () => fin('channel closed');
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') fin('직접 연결에 실패했어요 (네트워크가 P2P를 막고 있을 수 있어요)');
      };
      await pc.setLocalDescription(await pc.createOffer());
      await waitGathering(pc, 4000);
      const nonce = NT.utils.bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
      const offer = { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
      const m = await signal(desk, relays, { type: 'offer', sdp: offer, nonce },
        (m) => (m.type === 'answer' || m.type === 'denied') && m.nonce === nonce, 25000);
      if (m.type === 'denied') { const e = new Error('이 기기는 짝 맺기가 해제됐어요. 데스크탑에서 QR로 다시 연결하세요.'); e.denied = true; throw e; }
      await pc.setRemoteDescription(m.sdp);
    })().catch((e) => { sock.lastError = e; fin(e.message); });

    return sock;
  }

  window.ZDP2P = { pair, connect };
})();
