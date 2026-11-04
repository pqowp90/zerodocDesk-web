// DeskDoc web client: keyboard shortcuts. The server keeps the table (keys.rs, prefs' `keys`);
// the page only turns key presses into combo strings, looks them up, and draws settings › 단축키.
'use strict';

/** @type {{action:string, label:string, keys:string[], default:boolean, defaults:string[]}[]} */
let keyBindings = [];
/** combo string → action id */
let keyMap = new Map();

// Key names follow the physical key (KeyboardEvent.code), so a Korean IME doesn't change them.
const KEY_NAMES = {
  Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backquote: '`', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter',
  Escape: 'Esc', Space: 'Space', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home',
  End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left',
  ArrowRight: 'Right', NumpadAdd: 'Num+', NumpadSubtract: 'Num-', NumpadMultiply: 'Num*', NumpadDivide: 'Num/',
  NumpadDecimal: 'Num.',
};
function keyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return 'Num' + code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code;
  return KEY_NAMES[code] || null;
}
/** "Ctrl+Alt+Shift+K" (keys.rs format), or null for a key no shortcut can use. */
function comboOf(e) {
  if (e.metaKey) return null;
  const k = keyName(e.code);
  return k && (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + k;
}
/** The action id this key press runs, or null. */
function keyAction(e) {
  const c = keyMap.size ? comboOf(e) : null;
  return (c && keyMap.get(c)) || null;
}
/** The first combo of `action`, for "(Ctrl+B)" in tooltips; '' = none. */
function keyOf(action) {
  const b = keyBindings.find((x) => x.action === action);
  return (b && b.keys[0]) || '';
}

function onKeys(list) {
  keyBindings = list;
  keyMap = new Map(list.flatMap((b) => b.keys.map((k) => [k, b.action])));
  // Tooltips that name a shortcut: their text without the "(…)" part, then the current key.
  for (const x of document.querySelectorAll('[data-key]')) {
    if (x.dataset.tip === undefined) x.dataset.tip = x.title.replace(/\s*\([^)]*\)\s*$/, '');
    const k = keyOf(x.dataset.key);
    x.title = k ? `${x.dataset.tip} (${k})` : x.dataset.tip;
  }
  for (const x of document.querySelectorAll('[data-key-kbd]')) {
    x.textContent = keyOf(x.dataset.keyKbd);
    x.hidden = !x.textContent;
  }
  renderKeySet();
}

// ---- settings › 단축키 ----
// This PC's shortcuts: the desktop window changes them, other devices just use them.
const keysEditable = isDesktop && !p2pMode;
/** action id waiting for its new key press, or null */
let keyCapture = null;
/** {action, msg}: the last change refused, shown under its row */
let keyErr = null;

function kbd(text) { return el('kbd', 'key-kbd', text); }
function renderKeySet() {
  const rows = keyBindings.map((b) => {
    const row = el('div', 'key-row');
    const name = el('span', 'key-name', b.label);
    const combos = el('span', 'key-combos');
    if (keyCapture === b.action) combos.append(el('span', 'key-wait', txt('keys.waiting')));
    else if (b.keys.length) combos.append(...b.keys.map(kbd));
    else combos.append(el('span', 'key-off', txt('keys.none')));
    row.append(name, combos);
    if (keysEditable) {
      const btn = (text, cls, title, fn) => {
        const x = el('button', cls, text);
        x.type = 'button';
        x.title = title;
        x.onclick = fn;
        return x;
      };
      const editing = keyCapture === b.action;
      row.append(btn(editing ? txt('keys.cancel') : txt('keys.change'), 'act ghost key-edit', editing ? txt('keys.cancel_tip') : txt('keys.change_tip'), () => {
        keyErr = null;
        keyCapture = editing ? null : b.action;
        renderKeySet();
      }));
      const off = btn('×', 'icon', txt('keys.off_tip'), () => { keyErr = null; keyCapture = null; send({ t: 'key', action: b.action, key: '' }); });
      off.disabled = !b.keys.length;
      const def = btn('↺', 'icon', txt('keys.default_tip', { keys: b.defaults.join(', ') }), () => { keyErr = null; keyCapture = null; send({ t: 'key', action: b.action }); });
      def.disabled = b.default;
      row.append(off, def);
    }
    if (keyErr && keyErr.action === b.action) {
      const wrap = el('div', 'key-item');
      wrap.append(row, el('div', 'key-err', keyErr.msg));
      return wrap;
    }
    return row;
  });
  $('#key-rows').replaceChildren(...rows);
}
function onKeyDone(m) {
  if (m.error) { keyErr = { action: m.action, msg: m.error }; renderKeySet(); }
}

// The new key for the row being changed. Registered before settings.js's Esc (close settings),
// so Esc here only cancels, and no shortcut runs while a key is being picked.
addEventListener('keydown', (e) => {
  if (!keyCapture) return;
  if ($('#settings').hidden || $('#shortcuts').hidden) { keyCapture = null; return; }
  e.preventDefault();
  e.stopImmediatePropagation();
  if (['Control', 'Shift', 'Alt', 'Meta', 'Process'].includes(e.key) || e.repeat) return;
  const action = keyCapture;
  if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { keyCapture = null; renderKeySet(); return; }
  const c = comboOf(e);
  keyCapture = null;
  if (!c) keyErr = { action, msg: txt('keys.invalid') };
  else send({ t: 'key', action, key: c });
  renderKeySet();
}, true);

$('#keys-reset').onclick = () => { keyErr = null; keyCapture = null; send({ t: 'key' }); };
$('#keys-reset').hidden = !keysEditable;
$('#keys-hint').hidden = !keysEditable;
$('#keys-ro').hidden = keysEditable;
// No keyboard on a phone.
if (touch) document.querySelector('.set-nav [data-pane="shortcuts"]').hidden = true;
