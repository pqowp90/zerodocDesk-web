// Text in this device's language, from STRINGS (js/strings.js). Each device picks its own
// language, so the desktop's errors carry an id ({code, args}) and are put into words here.

/** This device's language: the first browser language with a table, else the default. */
const LANG = (() => {
  for (const l of navigator.languages || [navigator.language || '']) {
    const base = String(l).toLowerCase().split('-')[0];
    if (STRINGS[base]) return base;
  }
  return 'ko';
})();
document.documentElement.lang = LANG;

/** The text for `id`, `{name}` filled from `args`. Falls back to Korean, then `fallback`, then the id. */
function txt(id, args, fallback) {
  const s = STRINGS[LANG]?.[id] ?? STRINGS.ko[id] ?? fallback ?? id;
  return args ? s.replace(/\{(\w+)\}/g, (all, k) => (k in args ? String(args[k]) : all)) : s;
}

/** An error reply's text: by its id when the desktop sent one (plus the cause under it, `detail`),
 *  else the sentence it sent. */
function errText(m) {
  const said = m.msg ?? m.error;
  if (!m.code) return said;
  const s = txt(m.code, m.args, said);
  return m.detail ? `${s}: ${m.detail}` : s;
}

/** Fills `data-i18n` (text), `data-i18n-title` and `data-i18n-ph` (placeholder) under `root`. */
function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = txt(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = txt(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = txt(el.dataset.i18nPh);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', txt(el.dataset.i18nAria));
}
applyI18n();
