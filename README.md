# zerodocDesk-web

Remote page for zerodocDesk (served at https://desk.zerodoc.kr).

Static files only — no secrets live here. A device can reach a desktop only after pairing with
the QR shown in the zerodocDesk app; the session then runs peer-to-peer over WebRTC, with Nostr
relays used just for the encrypted handshake.

Generated from `crates/zd-server/web` in the zerodocDesk app repo — edit there, not here.

Bundled: xterm.js (MIT), nostr-tools (Unlicense) — see `vendor/`.
