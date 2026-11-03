// DeskDoc web client: window chrome (new tab buttons, soft keys) and start-up.
'use strict';

// ---- chrome ----
$('#new-claude').onclick = () => newTab(true);
$('#new-shell').onclick = () => newTab(false);
$('#pair-btn').onclick = () => send({ t: 'pair' });
$('#remote-on').onchange = (e) => send({ t: 'remote', on: e.target.checked });

const KEYS = { esc: '\x1b', tab: '\t', stab: '\x1b[Z', ctrlc: '\x03', nl: '\x1b\r', enter: '\r' };
for (const b of document.querySelectorAll('#keys button')) {
  b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the soft keyboard open
  b.addEventListener('click', () => {
    if (active === null) return;
    const k = b.dataset.k;
    // With the input box shown, Enter/newline act on the box when it has content.
    if (composeShown() && k === 'enter' && (ta.value || atts.length || quotes.length)) { sendCompose(); return; }
    if (composeShown() && k === 'nl' && document.activeElement === ta) { ta.setRangeText('\n', ta.selectionStart, ta.selectionEnd, 'end'); growInput(); return; }
    const appCursor = sessions.get(active).term.modes.applicationCursorKeysMode;
    const arrow = { up: 'A', down: 'B' }[k];
    input(active, arrow ? (appCursor ? '\x1bO' : '\x1b[') + arrow : KEYS[k]);
  });
}

new ResizeObserver(() => { if (active !== null) fitActive(); }).observe($('#terms'));
(async () => {
  if (p2pMode) await pairFromHash();
  connect();
})();
