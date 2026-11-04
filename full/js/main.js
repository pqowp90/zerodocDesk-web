// DeskDoc web client: window chrome (new tab buttons) and start-up.
'use strict';

// ---- chrome ----
$('#new-claude').onclick = () => newTab(true);
$('#new-shell').onclick = () => newTab(false);
$('#pair-btn').onclick = () => send({ t: 'pair' });
$('#remote-on').onchange = (e) => send({ t: 'remote', on: e.target.checked });

new ResizeObserver(() => { if (active !== null) fitActive(); }).observe($('#terms'));
(async () => {
  if (p2pMode) await pairFromHash();
  connect();
})();
