// Theme before the first paint (no dark flash in light mode); app.js changes it later.
// Loaded from <head> as a file, not inline: the page's CSP allows no inline scripts.
try { document.documentElement.dataset.theme = localStorage.getItem('zd-theme') === 'light' ? 'light' : 'dark'; } catch {}
