// DeskDoc web client: the conversation view: items, subagents, markdown, file paths, code colors, images.
'use strict';

function onChat(m) {
  const s = sessions.get(m.id);
  if (!s) return;
  if (m.conv && m.conv !== s.conv) { s.conv = m.conv; adoptDrafts(); } // null: not found yet, keep the last
  if (m.reset || !s.chat) s.chat = [];
  s.note = m.note || null; // an older desktop app sends none
  s.chat.push(...m.items);
  confirmPending(s);
  const ctxKey = JSON.stringify(m.ctx ?? null);
  if (ctxKey !== JSON.stringify(s.ctx ?? null)) { s.ctx = m.ctx ?? null; if (m.id === active) renderUsage(); }
  if (m.id === active && chatShown()) renderChat(m.reset);
  const agentKey = JSON.stringify(m.agents || []); // an older desktop app sends none
  if (agentKey !== JSON.stringify(s.agents || [])) { s.agents = m.agents || []; if (m.id === active) renderAgents(); }
}

/** The active conversation's working subagents over the input box: type, task, latest call. */
function renderAgents() {
  const list = (active !== null && sessions.get(active)?.agents) || [];
  const box = $('#agent-list');
  box.hidden = !list.length;
  if (!list.length) { box.replaceChildren(); return; }
  box.classList.toggle('open', load('zd-agents-open') === '1');
  const head = el('button', 'ah');
  head.type = 'button';
  head.title = '눌러서 펼치기 / 접기';
  head.innerHTML = '<span class="spin"></span><span></span><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>';
  head.children[1].textContent = `서브 에이전트 ${list.length}개 작업 중`;
  head.onclick = () => store('zd-agents-open', box.classList.toggle('open') ? '1' : undefined);
  const body = el('div', 'ab');
  body.append(...list.map((a) => {
    const row = el('div', 'ai-row');
    const act = a.tool ? `${a.tool}${a.detail ? ' · ' + a.detail : ''}` : '';
    row.title = [a.kind, a.description, act].filter(Boolean).join('\n');
    row.append(el('b', '', a.kind || '서브 에이전트'), el('span', 'ad', a.description), el('span', 'aa', act));
    return row;
  }));
  box.replaceChildren(head, body);
}

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- file paths in the chat ----
// Paths Claude writes become links: an image opens in a viewer (and gets a thumbnail under the
// message), anything else opens File Explorer on this PC. Other devices can't use this PC's
// Explorer, so there only images are links. The server reads the files ({t:"file"}).
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
// In running text: C:\… or D:/… or \\server\…, up to a space or a character no path has.
const TEXT_PATH_RE = /(?<![\w\/\\:.])(?:[A-Za-z]:[\\\/]|\\\\[\w.-]+\\)[^\s<>"'`|*?]+/g;
// A whole `code` span or link target that is a path: absolute (spaces allowed), ~/…,
// or relative with at least one folder and a file extension (crates/app/src/main.rs).
const ABS_PATH_RE = /^(?:[A-Za-z]:[\\\/]|\\\\[\w.-]+\\|~[\\\/])[^<>"|*?\n]*$/;
const REL_PATH_RE = /^(?:\.{1,2}[\\\/])*[\w@.-]+(?:[\\\/][\w@. ()+-]+)*[\\\/][\w@. ()+-]*\.[A-Za-z0-9]{1,8}$/;

/** The path in a `code` span or link target ("a/b.rs:12", "a/b.rs#L3" → "a/b.rs"), or null. */
function asPath(t) {
  const m = t.trim().match(/^(.+?)(?::\d+(?:[:-]\d+)?|#L\d+(?:-L?\d+)?)?$/);
  const p = m && m[1];
  return p && (ABS_PATH_RE.test(p) || REL_PATH_RE.test(p)) ? p : null;
}

/** A path found in running text, without what follows it there: "a.png)," / "a.png에서". */
function trimTextPath(p) {
  p = p.replace(/[.,;:!?)\]}]+$/, '');
  const m = p.match(/^(.*\.[A-Za-z0-9]{1,8})[\u3131-\uD7A3]+$/);
  return m ? m[1] : p;
}

/** `label` (HTML) as a link to `path`, or as is where it couldn't open anything. */
function pathLink(path, label) {
  const img = IMG_EXT_RE.test(path);
  if (!img && !isDesktop) return label;
  return `<a class="path${img ? ' img' : ''}" href="#" data-path="${escHtml(path)}" title="${escHtml(path)}\n${img ? '눌러서 보기' : '탐색기에서 열기'}">${label}</a>`;
}

/** Inline markdown on one line of raw text; everything is escaped first. */
function mdInline(src) {
  // Finished pieces (code, links, paths) wait as placeholders while the rest is escaped and styled.
  const held = [];
  const plain = []; // a code span's HTML without its path link, for use inside another link
  const hold = (html) => { held.push(html); return `\u0000${held.length - 1}\u0000`; };
  let s = src.replace(/\u0000/g, '').replace(/`([^`\n]+)`/g, (_, c) => {
    const code = `<code>${escHtml(c)}</code>`;
    const p = asPath(c);
    plain[held.length] = code;
    return hold(p ? pathLink(p, code) : code);
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, href) => {
    const label = escHtml(text).replace(/\u0000(\d+)\u0000/g, (_, i) => plain[i] ?? held[i]);
    if (/^https?:\/\//.test(href)) return hold(`<a href="${escHtml(href)}" target="_blank" rel="noopener">${label}</a>`);
    let target = href;
    try { target = decodeURIComponent(href); } catch { /* keep as written */ }
    const p = asPath(target);
    return p ? hold(pathLink(p, label)) : all;
  });
  s = s.replace(TEXT_PATH_RE, (m) => {
    const p = trimTextPath(m);
    return hold(pathLink(p, escHtml(p))) + m.slice(p.length);
  });
  s = escHtml(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  // Placeholders can nest (a `code` inside a link's text).
  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
  return s;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => mdInline(c.trim()));

function mdList(items) {
  let out = '';
  const stack = [];
  for (const it of items) {
    while (stack.length > 1 && it.ind < stack[stack.length - 1].ind) out += `</li></${stack.pop().tag}>`;
    const tag = it.ord ? 'ol' : 'ul';
    let top = stack[stack.length - 1];
    if (top && it.ind <= top.ind && top.tag !== tag) { out += `</li></${stack.pop().tag}>`; top = null; } // - then 1.
    if (!top || it.ind > top.ind) {
      stack.push({ ind: it.ind, tag });
      out += `<${tag}><li>`;
    } else out += '</li><li>';
    out += it.text.split('\n').map(mdInline).join('<br>');
  }
  while (stack.length) out += `</li></${stack.pop().tag}>`;
  return out;
}

// ---- code-block colors ----
// A small tokenizer, enough to color code blocks the way the CLI does: comments, strings,
// numbers, keywords, calls and types. Unknown or untagged blocks stay plain (they are mostly
// command output), except diffs, which are recognized by their lines.
const HL_KW = {
  js: 'as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while with yield',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield',
  sh: 'case do done echo elif else esac exit export fi for function if in local return set source then unset until while cd',
  ps: 'begin break catch class continue do else elseif end exit filter finally for foreach function if in param process return switch throw trap try until while',
  c: 'abstract async auto await bool boolean break case catch chan char class const continue default defer delete do double else enum extends extern false final finally float for func go goto if implements import int interface long map namespace new null nullptr override package private protected public range register return select short signed sizeof static string struct super switch template this throw throws true try type typedef typename union unsigned using var virtual void volatile while',
  conf: 'true false null yes no on off',
  sql: 'add all alter and as asc by create delete desc distinct drop from group having in index inner insert into is join key left like limit not null on or order primary references right select set table union update values where',
};
const HL_LANG = {
  js: 'js', javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', cjs: 'js', json: 'js', jsonc: 'js',
  rs: 'rust', rust: 'rust',
  py: 'py', python: 'py',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  ps1: 'ps', powershell: 'ps', pwsh: 'ps',
  c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cs: 'c', csharp: 'c', 'c#': 'c', java: 'c', kotlin: 'c', kt: 'c',
  go: 'c', swift: 'c', dart: 'c', scala: 'c', php: 'c', css: 'c', scss: 'c',
  sql: 'sql', toml: 'conf', yaml: 'conf', yml: 'conf', ini: 'conf', dockerfile: 'sh', makefile: 'sh',
  diff: 'diff', patch: 'diff',
};
const hlCache = {};
function hlRule(kind) {
  if (hlCache[kind]) return hlCache[kind];
  const hash = /^(py|sh|ps|conf)$/.test(kind);
  const com = [hash ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', kind === 'sql' ? '--[^\\n]*' : '', kind === 'ps' ? '<#[\\s\\S]*?#>' : '']
    .filter(Boolean).join('|');
  const str = [kind === 'py' ? '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'' : '', '"(?:\\\\.|[^"\\\\\\n])*"',
    // Rust's 'a lifetimes are not strings: only one-character literals there
    kind === 'rust' ? "'(?:\\\\.|[^'\\\\\\n])'" : "'(?:\\\\.|[^'\\\\\\n])*'", kind === 'js' ? '`(?:\\\\.|[^`\\\\])*`' : '']
    .filter(Boolean).join('|');
  const re = new RegExp(`(?<c>${com})|(?<s>${str})|(?<v>${kind === 'sh' || kind === 'ps' || kind === 'c' ? '\\$\\{?[A-Za-z_][\\w:]*\\}?' : '(?!)'})` +
    `|(?<n>\\b(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)|(?<w>[A-Za-z_][\\w$]*${kind === 'ps' ? '(?:-[A-Za-z]\\w*)?' : '(?:!(?!=))?'})(?<call>\\s*\\()?`, 'g');
  const kw = new Set(HL_KW[kind].split(' '));
  return (hlCache[kind] = { re, kw, ci: kind === 'sql' || kind === 'ps' });
}

/** Code-block text → HTML with `hl-*` spans; everything is escaped. */
function highlight(code, lang) {
  let kind = HL_LANG[(lang || '').toLowerCase()];
  if (!kind && /^(@@ |[+-]{3} )/m.test(code) && /^[+-]/m.test(code)) kind = 'diff';
  if (!kind) return escHtml(code);
  if (kind === 'diff') {
    return code.split('\n').map((l) => {
      const c = /^(\+\+\+|---)( |$)/.test(l) ? 'kw' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l.startsWith('@@') ? 'hunk' : '';
      return c ? `<span class="hl-${c}">${escHtml(l)}</span>` : escHtml(l);
    }).join('\n');
  }
  const { re, kw, ci } = hlRule(kind);
  let out = '', at = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(code))) {
    const g = m.groups;
    let cls = g.c != null ? 'com' : g.s != null ? 'str' : g.v != null ? 'var' : g.n != null ? 'num' : '';
    let tok = m[0];
    if (g.w != null) {
      tok = g.w;
      re.lastIndex = m.index + tok.length; // leave the "(" for the next round
      const w = ci ? tok.toLowerCase() : tok;
      cls = kw.has(w) ? 'kw' : g.call != null || tok.endsWith('!') || tok.includes('-') ? 'fn'
        : /^[A-Z][a-z0-9]/.test(tok) ? 'type' : '';
    }
    out += escHtml(code.slice(at, m.index)) + (cls ? `<span class="hl-${cls}">${escHtml(tok)}</span>` : escHtml(tok));
    at = m.index + tok.length;
  }
  return out + escHtml(code.slice(at));
}

/** Small, safe markdown renderer: headings, lists, code, quotes, tables, rules, paragraphs. */
function md(src) {
  const lines = src.replace(/\r/g, '').split('\n');
  let html = '';
  const para = [];
  const flush = () => { if (para.length) { html += `<p>${para.map(mdInline).join('<br>')}</p>`; para.length = 0; } };
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/))) {
      flush();
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) body.push(lines[i]);
      i++;
      html += `<pre><code>${highlight(body.join('\n'), m[2])}</code></pre>`;
    } else if (!l.trim()) {
      flush(); i++;
    } else if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      flush(); i++;
      html += `<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      flush(); i++;
      html += '<hr>';
    } else if (/^\s*>/.test(l)) {
      flush();
      const body = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*> ?/, ''));
      html += `<blockquote>${md(body.join('\n'))}</blockquote>`;
    } else if (l.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flush();
      let t = `<table><thead><tr>${cells(l).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
        t += `<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join('')}</tr>`;
      }
      html += `<div class="tbl">${t}</tbody></table></div>`;
    } else if (LIST_RE.test(l)) {
      flush();
      const items = [];
      while (i < lines.length) {
        const lm = lines[i].match(LIST_RE);
        if (lm) { items.push({ ind: lm[1].replace(/\t/g, '    ').length, ord: /\d/.test(lm[2]), text: lm[3] }); i++; }
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i])) { items[items.length - 1].text += '\n' + lines[i].trim(); i++; }
        else break;
      }
      html += mdList(items);
    } else {
      para.push(l); i++;
    }
  }
  flush();
  return html;
}

// ---- images from paths: thumbnails, viewer ----
const fileReqs = new Map(); // rid → { parts, resolve, reject, timer }
const fileUrls = new Map(); // "tab\npath" → Promise<object URL>

/** Asks the desktop for an image the chat shows; one request per tab and source.
 *  `src`: { path } (a path the conversation names) or { img } (a pasted image's key). */
function fetchFile(tab, src) {
  const key = `${tab}\n${src.img ? `img:${src.img}` : src.path}`;
  if (!fileUrls.has(key)) {
    const p = new Promise((resolve, reject) => {
      const rid = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { fileReqs.delete(rid); reject(new Error('응답이 없어요')); }, 30000);
      fileReqs.set(rid, { parts: [], resolve, reject, timer });
      send({ t: 'file', rid, id: tab, ...src });
    });
    fileUrls.set(key, p.catch((e) => { fileUrls.delete(key); throw e; }));
  }
  return fileUrls.get(key);
}

function onFile(m) {
  const r = fileReqs.get(m.rid);
  if (!r) return;
  const done = () => { fileReqs.delete(m.rid); clearTimeout(r.timer); };
  if (m.error) { done(); r.reject(new Error(m.error)); return; }
  r.parts[m.seq] = Uint8Array.from(atob(m.d), (c) => c.charCodeAt(0));
  if (m.last) { done(); r.resolve(URL.createObjectURL(new Blob(r.parts, { type: m.mime }))); }
}

// Thumbnails load once they come near the screen: a long history may name many images.
const thumbObs = new IntersectionObserver((ents) => {
  for (const e of ents) {
    if (!e.isIntersecting) continue;
    thumbObs.unobserve(e.target);
    const b = e.target;
    fetchFile(+b.dataset.tab, thumbSrc(b)).then((url) => {
      const img = el('img');
      img.src = url;
      img.alt = b.title;
      b.replaceChildren(img);
    }, (err) => {
      b.classList.add('err');
      b.replaceChildren(el('span', 'cimg-note', `🖼 ${err.message}`));
    });
  }
}, { root: chat, rootMargin: '400px 0px' });

/** What a thumbnail or link shows: { img } for a pasted image, else { path }. */
const thumbSrc = (e) => (e.dataset.img ? { img: e.dataset.img } : { path: e.dataset.path });

/** A row of thumbnails for the images `paths` name and the pasted images `imgs`, or null. */
function imgThumbs(paths, imgs = []) {
  const list = [
    ...imgs.map((img) => ({ img, title: '붙여 넣은 이미지' })),
    ...[...new Set(paths)].filter((p) => IMG_EXT_RE.test(p)).map((path) => ({ path, title: path })),
  ];
  if (!list.length || active === null) return null;
  const box = el('div', 'cimgs');
  for (const s of list) {
    const b = el('button', 'cimg');
    b.type = 'button';
    b.dataset.tab = active;
    if (s.img) b.dataset.img = s.img; else b.dataset.path = s.path;
    b.title = s.title;
    b.append(el('span', 'cimg-note', '불러오는 중…'));
    box.append(b);
    thumbObs.observe(b);
  }
  return box;
}

const viewer = el('div', 'viewer');
viewer.hidden = true;
document.body.append(viewer);
viewer.onclick = (e) => { if (e.target === viewer || e.target.tagName === 'IMG') closeViewer(); };
function closeViewer() { viewer.hidden = true; viewer.replaceChildren(); }
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !viewer.hidden) { e.preventDefault(); e.stopPropagation(); closeViewer(); } }, true);

/** `src`: { path } or { img }, as for fetchFile. */
function openViewer(tab, src) {
  const path = src.path;
  const label = path || '붙여 넣은 이미지';
  const img = el('img');
  img.alt = label;
  const bar = el('div', 'vbar');
  bar.append(el('span', 'vpath', label));
  if (isDesktop && path) {
    const b = el('button', 'act ghost', '탐색기에서 보기');
    b.type = 'button';
    b.onclick = () => send({ t: 'reveal', id: tab, path });
    bar.append(b);
  }
  const x = el('button', 'act ghost', '닫기 (Esc)');
  x.type = 'button';
  x.onclick = closeViewer;
  bar.append(x);
  viewer.replaceChildren(img, bar);
  viewer.hidden = false;
  fetchFile(tab, src).then((url) => { img.src = url; }, (err) => img.replaceWith(el('div', 'vnote', err.message)));
}

chat.addEventListener('click', (e) => {
  const a = e.target.closest('a.path, .cimg');
  if (!a || active === null) return;
  e.preventDefault();
  if (a.classList.contains('err')) return;
  const tab = a.dataset.tab ? +a.dataset.tab : active;
  if (a.dataset.img || IMG_EXT_RE.test(a.dataset.path)) openViewer(tab, thumbSrc(a));
  else send({ t: 'reveal', id: tab, path: a.dataset.path });
});

/** Whether a message is long enough to fold (a pasted log, say). By text, so it works before layout. */
const longText = (t) => t.length > 1500 || t.split('\n').length > 12;

/** A user bubble. A long one shows its first lines and a button to open or fold the rest. */
function userBubble(text) {
  if (!longText(text)) return el('div', 'msg user', text);
  const d = el('div', 'msg user long');
  const lines = text.split('\n').length;
  const more = el('button', 'msg-more', `전체 보기 (${lines}줄)`);
  more.type = 'button';
  more.onclick = () => {
    const open = d.classList.toggle('open');
    more.textContent = open ? '접기' : `전체 보기 (${lines}줄)`;
    // Folding a bubble whose top has scrolled away: bring it back rather than land past it.
    const gap = d.getBoundingClientRect().top - chat.getBoundingClientRect().top;
    if (!open && gap < 0) chat.scrollTop += gap - 12;
    updateChatHead();
    queueChatRail();
  };
  d.append(el('span', 'msg-t', text), more);
  return d;
}

function chatItemEl(it) {
  if (it.k === 'user') {
    const d = userBubble(it.text);
    d.dataset.q = it.text || (it.images?.length ? `🖼 이미지 ${it.images.length}장` : '');
    const thumbs = imgThumbs((it.text.match(TEXT_PATH_RE) || []).map(trimTextPath), it.images || []);
    if (!thumbs) return d;
    // Only images: they go in the bubble rather than under an empty one.
    if (!it.text) { d.append(thumbs); return d; }
    const wrap = el('div', 'msg-wrap');
    wrap.append(d, thumbs);
    return wrap;
  }
  if (it.k === 'ai') {
    const d = el('div', 'msg ai');
    d.innerHTML = md(it.text);
    const thumbs = imgThumbs([...d.querySelectorAll('a.path.img')].map((a) => a.dataset.path));
    if (thumbs) d.append(thumbs);
    return d;
  }
  if (it.k === 'compact') {
    const d = el('div', 'chat-compact');
    d.append(el('span', '', it.auto ? '컨텍스트가 차서 여기서 자동으로 요약했어요' : '여기서 대화를 요약했어요'));
    d.title = '이 위의 내용은 이제 Claude에게 요약본으로만 남아 있어요';
    return d;
  }
  const d = el('div', 'tool');
  d.append(el('span', 'tname', it.name), el('span', 'tdet', it.detail || ''));
  d.title = `${it.name} ${it.detail || ''}`;
  return d;
}
