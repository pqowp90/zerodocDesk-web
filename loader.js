// DeskDoc hosted loader (desk.zerodoc.kr): pairing, picking a PC and the connection, nothing else.
// The screen comes from the desktop it connects to ({t:"webui"}, `Server::web_ui` in api.rs), so a
// phone always runs the UI of the app it talks to (DeskDoc or DeskDoc Dev), and this site, which
// every paired phone trusts, rarely changes. Received screens are cached by hash: the next start
// only asks "same?". Desktop apps from before {t:"webui"} get the old full page under full/.
'use strict';

(() => {
  const $ = (s) => document.querySelector(s);
  const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const store = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  const HEX = /^[0-9a-f]{64}$/;
  const CACHE = 'zd-webui';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /** Shared with the desktop's screen once it runs (js/connect.js reads it). */
  const boot = {
    hash: '',            // the screen running now
    desk: null,          // the desktop it came from
    installPrompt: null, // Chrome's install offer, if it came before the screen
    sock: null,
    pending: [],
    /** The open connection, once. What arrived meanwhile comes through its `replay()`. */
    take() {
      const s = boot.sock;
      boot.sock = null;
      if (!s || s.readyState !== 1) return null;
      s.taken = true;
      s.replay = () => { for (const e of boot.pending.splice(0)) s.onmessage && s.onmessage(e); };
      return s;
    },
    /** That desktop unpaired this device. */
    forget(pub) { saveDesks(desks().filter((d) => d.pub !== pub)); },
    onWebui: null, // set below: the screen asks again after a reconnect
  };
  window.ZDBOOT = boot;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); boot.installPrompt = e; });
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

  // ---- paired desktops ----
  /** Last used first: [{pub, relays, name}]. `zd-desk` holds the one in use (the screen reads it). */
  function desks() {
    let list = [];
    try { list = JSON.parse(load('zd-desks') || '[]'); } catch {}
    if (!Array.isArray(list)) list = [];
    if (!list.length) {
      // Paired before the loader existed: one desktop, in zd-desk.
      try {
        const d = JSON.parse(load('zd-desk') || 'null');
        if (d && d.pub) list = [{ pub: d.pub, relays: d.relays || [], name: 'DeskDoc' }];
      } catch {}
    }
    return list.filter((d) => d && HEX.test(d.pub) && Array.isArray(d.relays));
  }
  function saveDesks(list) { store('zd-desks', JSON.stringify(list)); }
  function useDesk(d) {
    saveDesks([d, ...desks().filter((x) => x.pub !== d.pub)]);
    store('zd-desk', JSON.stringify({ pub: d.pub, relays: d.relays }));
    try { sessionStorage.setItem('zd-picked', d.pub); } catch {} // a reload goes straight back to it
  }

  // ---- the loader's own screen ----
  function screen({ msg, pick = false, paste = false, retry = false, other = false }) {
    $('#msg').textContent = msg;
    $('#pick').hidden = !pick;
    $('#paste').hidden = !paste;
    $('#retry').hidden = !retry;
    $('#other').hidden = !other;
    $('#acts').hidden = !(retry || other);
  }

  function unpaired(err) {
    const help = '데스크탑 앱의 [설정] → [리모트] → "새 기기 연결 QR"을 이 기기로 찍어 주세요';
    if (!standalone) { screen({ msg: err ? `${err}\n\n${help}` : help }); return; }
    // An installed app can't be opened by the camera's link: it takes the link by paste.
    const how = iOS
      ? 'Safari에서 짝을 맺었다면 Safari의 [설정] → [화면] → "홈 화면 앱으로 연결 옮기기"로 복사한 링크를 붙여넣어 주세요.\n처음이라면 데스크탑 QR을 카메라로 찍어 Safari에서 먼저 짝을 맺어 주세요.'
      : '데스크탑 QR을 카메라로 찍거나, 복사한 연결 링크를 붙여넣어 주세요.';
    screen({ msg: err ? `${err}\n\n${how}` : how, paste: true });
  }

  function pick(list, msg) {
    const box = $('#pick');
    box.textContent = '';
    for (const d of list) {
      const b = Object.assign(document.createElement('button'), { type: 'button' });
      b.append(d.name, Object.assign(document.createElement('small'), { textContent: d.pub.slice(0, 8) }));
      b.onclick = () => go(d);
      box.append(b);
    }
    screen({ msg: msg || '어느 PC에 연결할까요?', pick: true });
  }

  $('#other').onclick = () => { attempt++; boot.sock?.close(); pick(desks()); };

  $('#paste').onsubmit = async (e) => {
    e.preventDefault();
    let p;
    try { p = new URLSearchParams(new URL($('#paste input').value.trim()).hash.slice(1)); } catch { p = new URLSearchParams(); }
    const err = await pairWith(p);
    if (err) unpaired(err);
    else go(desks()[0]);
  };

  /**
   * Pairs from link params: the desktop's QR `d=<desk key>&s=<secret>&r=<relays>&n=<app name>`,
   * or a move link `k=<this device's key>&d=&r=`. Returns an error message, or '' on success.
   */
  async function pairWith(p) {
    const d = p.get('d');
    const s = p.get('s');
    const k = p.get('k');
    const relays = (p.get('r') || '').split(',').filter(Boolean);
    if (!d || !HEX.test(d) || !(s || k) || (k && !HEX.test(k))) return '링크가 올바르지 않아요';
    const name = p.get('n') || desks().find((x) => x.pub === d)?.name || 'DeskDoc';
    if (k) {
      // An iPhone home-screen app doesn't share Safari's storage: take over the key Safari paired with.
      store('zd-sk', k);
    } else {
      screen({ msg: `${name}와 짝을 맺는 중…` });
      try {
        if (!(await ZDP2P.pair(d, relays, s))) return 'QR이 만료됐거나 이미 사용됐어요. 데스크탑에서 새 QR을 만들어 주세요.';
      } catch (e) {
        return e.message;
      }
    }
    useDesk({ pub: d, relays, name });
    return '';
  }

  // ---- screens received from desktops, cached by hash ----
  // Files are kept as base64 (pieces of 36 KiB, a multiple of 3, join into one valid string).
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const text = (b64) => new TextDecoder().decode(bytes(b64));

  async function readCache(hash) {
    if (!hash) return null;
    try {
      const r = await (await caches.open(CACHE)).match(`__webui/${hash}`);
      return r ? await r.json() : null;
    } catch {
      return null;
    }
  }

  async function writeCache(hash, files) {
    try {
      const c = await caches.open(CACHE);
      await c.put(`__webui/${hash}`, new Response(JSON.stringify(files), { headers: { 'content-type': 'application/json' } }));
      // Keep only the screens some paired desktop is on.
      const keep = new Set(desks().map((d) => load(`zd-webui-${d.pub}`)).concat(hash));
      for (const r of await c.keys()) if (!keep.has(r.url.split('/__webui/')[1])) await c.delete(r);
    } catch {}
  }

  /** Collects one {t:"webui"} answer, then calls `done(hash, files)` (files null = "same as yours"). */
  function receiver(done) {
    const parts = {};
    return (m) => {
      if (m.same) return done(m.hash, null);
      if (m.done) {
        const files = {};
        for (const [p, a] of Object.entries(parts)) files[p] = a.join('');
        return done(m.hash, files);
      }
      (parts[m.path] ||= []).push(m.d);
    };
  }

  /** Swaps this page for the desktop's screen: its styles, its body, then its scripts in order. */
  async function run(files) {
    const doc = new DOMParser().parseFromString(text(files['index.html']), 'text/html');
    const type = (p) => (p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    const scripts = [...doc.querySelectorAll('script')].map((s) => { s.remove(); return s.getAttribute('src'); });
    const styles = [...doc.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href'));
    $('#loader-css')?.remove();
    for (const p of styles) if (files[p]) document.head.append(Object.assign(document.createElement('style'), { textContent: text(files[p]) }));
    document.body.replaceWith(document.importNode(doc.body, true));
    for (const p of scripts) {
      if (!p || !files[p]) continue; // the loader's own (nostr, p2p.js): already running
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = URL.createObjectURL(new Blob([bytes(files[p])], { type: type(p) }));
        s.async = false;
        s.onload = res;
        s.onerror = () => rej(new Error(`${p}을(를) 실행하지 못했어요`));
        document.body.append(s);
      });
    }
  }

  // ---- connecting ----
  let attempt = 0; // a newer attempt (or "other PC") makes older ones' callbacks do nothing

  function go(d) {
    const gen = ++attempt;
    const others = desks().length > 1;
    useDesk(d);
    screen({ msg: `${d.name}에 연결하는 중…`, other: others });
    const sock = ZDP2P.connect(d.pub, d.relays);
    boot.sock = sock;
    boot.pending = [];
    let started = false; // the screen is starting: from here on the connection is its business
    let asked = false;    // asked once more with nothing cached (the cached copy went missing)

    const receive = receiver(async (hash, got) => {
      if (gen !== attempt) return;
      const files = got || (await readCache(hash));
      if (!files || !files['index.html']) {
        if (!got && !asked) { asked = true; sock.send(JSON.stringify({ t: 'webui', have: '' })); return; }
        screen({ msg: `${d.name}에서 화면을 받지 못했어요`, retry: true, other: others });
        $('#retry').onclick = () => go(d);
        sock.close();
        return;
      }
      if (got) {
        store(`zd-webui-${d.pub}`, hash);
        await writeCache(hash, got);
      }
      started = true;
      boot.hash = hash;
      boot.desk = d;
      try {
        await run(files);
      } catch (e) {
        // The page is half swapped: say so, and start over without the cached copy.
        store(`zd-webui-${d.pub}`, null);
        const again = Object.assign(document.createElement('button'), { type: 'button', textContent: '다시 불러오기' });
        again.onclick = () => location.reload();
        document.body.replaceChildren(Object.assign(document.createElement('p'), { textContent: `화면을 띄우지 못했어요: ${e.message}` }), again);
      }
    });

    sock.onstatus = (s) => { if (gen === attempt && !started) screen({ msg: `${d.name}에 연결하는 중…\n\n${s}`, other: others }); };
    sock.onopen = async () => {
      if (gen !== attempt) return;
      screen({ msg: `${d.name}: 화면 받는 중…` });
      const have = load(`zd-webui-${d.pub}`) || '';
      sock.send(JSON.stringify({ t: 'webui', have: (await readCache(have)) ? have : '' }));
    };
    sock.onmessage = (ev) => {
      if (!started && typeof ev.data === 'string') {
        let m = null;
        try { m = JSON.parse(ev.data); } catch {}
        if (m && m.t === 'webui') return receive(m);
        if (m && m.t === 'error' && /variant `webui`/.test(m.msg)) {
          // A desktop app from before the loader: the full page as it was then.
          started = true;
          sock.close();
          location.replace('full/');
          return;
        }
      }
      boot.pending.push(ev);
    };
    sock.onclose = (ev) => {
      if (gen !== attempt || started) return;
      boot.sock = null;
      if (sock.lastError && sock.lastError.denied) {
        boot.forget(d.pub);
        const msg = `${d.name}: 이 기기는 짝 맺기가 해제됐어요. 데스크탑에서 QR로 다시 연결하세요.`;
        const left = desks();
        if (left.length) pick(left, msg);
        else unpaired(msg);
        return;
      }
      screen({ msg: `${d.name}에 연결하지 못했어요\n\n${ev.reason || ''}`, retry: true, other: others });
      $('#retry').onclick = () => go(d);
    };
  }

  // The screen reconnected and asked again: a new screen (the desktop was updated) means reload.
  let again = null;
  boot.onWebui = (m) => {
    again ||= receiver(async (hash, got) => {
      again = null;
      if (!got || hash === boot.hash || !boot.desk) return;
      store(`zd-webui-${boot.desk.pub}`, hash);
      await writeCache(hash, got);
      location.reload();
    });
    again(m);
  };

  // ---- start ----
  (async () => {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('d')) {
      history.replaceState(null, '', location.pathname + location.search);
      const err = await pairWith(h);
      if (!err) return go(desks()[0]);
      const list = desks();
      return list.length ? pick(list, err) : unpaired(err);
    }
    const list = desks();
    if (!list.length) return unpaired('');
    let picked = null;
    try { picked = sessionStorage.getItem('zd-picked'); } catch {}
    const same = list.find((d) => d.pub === picked) || (list.length === 1 && list[0]);
    if (same) return go(same);
    pick(list);
  })();
})();
