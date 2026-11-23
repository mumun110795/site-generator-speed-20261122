// A fast drop-in replacement for makefun-site 1.0.0: run(input) returns the same output tree (path -> text) for
// every case, byte for byte, in a fraction of the CPU time. Written from the published semantics of makefun-site
// (its README and behaviour): the same front matter dialect, the same Markdown subset, the same template dialect,
// the same slug rule and the same build report. The speed comes from the shape of the work: slugs are memoised,
// HTML escaping runs over whole runs of plain text instead of single characters, the Markdown inline renderer
// scans one string by index instead of slicing substrings for every construct, word counting is a single pass,
// cards are built once per source, and templates render into one shared array of pieces.

// ------------------------------------------------------------------ text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** HTML-escape a whole string at once (the reference escapes the same five characters the same way). */
function esc(s) {
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

const MARKS_RE = /\p{M}/gu;
const SLUG_MAX = 64;
const slugCache = new Map();

/** The slug of a text, memoised: titles, tag names and heading texts repeat constantly across a site. */
function slugify(text) {
  let v = slugCache.get(text);
  if (v === undefined) {
    v = slugifyRaw(text);
    if (slugCache.size < 200000) slugCache.set(text, v);
  }
  return v;
}

function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  // Pure-ASCII text is unchanged by NFKD and holds no combining marks, so both steps can be skipped for it.
  if (!ascii) plain = text.normalize('NFKD').replace(MARKS_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;                       // A-Z lowered
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) { out += '-'; gap = false; }
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;                // a "-" left at the cut is dropped
  if (end !== out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against the `taken` set (and added to it): slug, slug-2, slug-3, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether a char code is JavaScript whitespace (the set \s matches), for counting words. */
function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 ||
    c === 12288 || c === 65279;
}

/** The number of words in a text: its runs of characters other than whitespace, counted in one pass. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // The whitespace test inlined: the ASCII members directly, the rest only for non-ASCII codes.
    if (c === 32 || (c >= 9 && c <= 13) || (c > 127 && isWsCode(c))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ------------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One front matter key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

const FM_BLANK = /^[ \t]*$/;
const FM_TRAIL = /[ \t]+$/;

/** A source's front matter and body: { data, body }, or { error } with the first reason it is refused. */
function parseFrontMatter(text) {
  // Only the front matter's own lines are ever cut out of the text; the body is the one slice after them.
  const firstNl = text.indexOf('\n');
  if ((firstNl === -1 ? text : text.slice(0, firstNl)) !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  const fmLines = [];
  let bodyStart = -1;
  let pos = firstNl + 1;
  for (;;) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (line === '---') {
      bodyStart = e === -1 ? text.length : e + 1;
      break;
    }
    fmLines.push(line);
    if (e === -1) return { error: 'the front matter is not closed' };
    pos = e + 1;
  }
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (FM_BLANK.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(FM_TRAIL, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ------------------------------------------------------------------ markdown

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;
const MD_WS = /\s/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '' || MD_BLANK.test(line)) return true;
  // The other three are anchored on their first character, so the rest need no test at all.
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return MD_FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return MD_HR.test(line);
  return false;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// The characters a backslash escapes, as a lookup by char code (all are ASCII).
const ESCAPABLE = new Array(128).fill(false);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = true;

function escapableAt(s, j) {
  const code = s.charCodeAt(j);
  return code < 128 && ESCAPABLE[code];
}

/** The first index in [from, hi) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  const w0 = what.charCodeAt(0);
  for (let j = from; j <= hi - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && escapableAt(s, j + 1)) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) === w0 && s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, hi) (one not followed by another *), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const code = s.charCodeAt(j);
    if (code === 92 && j + 1 < hi && escapableAt(s, j + 1)) {
      j++;
      continue;
    }
    if (code !== 42) continue;
    if (j + 1 < hi && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[lo, hi)` rendered inline, pieces pushed onto `out`. Plain characters accumulate into a run that is
 * escaped in one call when a construct interrupts it; constructs are located by index in the one string
 * and rendered by recursing on their index range, never on sliced copies.
 */
function inlineRange(s, lo, hi, env, out) {
  let i = lo;
  let run = lo;
  while (i < hi) {
    const code = s.charCodeAt(i);
    if (code === 92) {                                    // backslash
      if (i + 1 < hi && escapableAt(s, i + 1)) {
        if (i > run) out.push(esc(s.slice(run, i)));
        const ch = s[i + 1];
        out.push(ch === '>' ? '&gt;' : ch);               // of the escapable characters only > is HTML-special
        i += 2;
        run = i;
      } else i++;
      continue;
    }
    if (code === 96) {                                    // backtick: a code span
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        if (i > run) out.push(esc(s.slice(run, i)));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (code === 42) {                                    // *: strong or emphasis
      if (i + 1 < hi && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          if (i > run) out.push(esc(s.slice(run, i)));
          out.push('<strong>');
          inlineRange(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1) {
        if (i > run) out.push(esc(s.slice(run, i)));
        out.push('<em>');
        inlineRange(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (code === 91) {                                    // [: a link
      const k = findUnescaped(s, ']', i + 1, hi);
      let m = -1;
      if (k !== -1 && k + 1 < hi && s.charCodeAt(k + 1) === 40) {
        m = s.indexOf(')', k + 2);
        if (m >= hi) m = -1;
      }
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !MD_WS.test(target)) {
          if (i > run) out.push(esc(s.slice(run, i)));
          out.push('<a href="', esc(env.link(target)), '">');
          inlineRange(s, i + 1, k, env, out);
          out.push('</a>');
          i = m + 1;
          run = i;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  if (hi > run) out.push(esc(s.slice(run, hi)));
}

/** A whole string rendered inline. */
function inlineStr(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/**
 * A body's Markdown rendered in one pass over its lines: its HTML (each block followed by "\n"), its table
 * of contents (every level 2 and 3 heading: level, id, inline HTML) and its excerpt (the first paragraph's
 * inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    // Blocks are told apart by their first character (every pattern is anchored), tested in the
    // reference's order within each character: blank, fence, heading, break, quote, list, paragraph.
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {                                      // a fence
      const fence = MD_FENCE_OPEN.exec(line);
      if (fence !== null) {
        i++;
        let body = '';
        while (i < n && !MD_FENCE_CLOSE.test(lines[i])) {
          body += esc(lines[i]) + '\n';
          i++;
        }
        i++;
        out.push('<pre><code', fence[1] === '' ? '' : ` class="language-${esc(fence[1])}"`, '>', body, '</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {                               // '#': a heading
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inlineStr(heading.text, env);
        out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {                  // '-' or '*': a thematic break first
      if (MD_HR.test(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
    } else if (c0 === 62) {                               // '>': a blockquote
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const t = trimLine(lines[i].replace(/^> ?/, ''));
        if (t !== '') kept.push(t);
        i++;
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push('<blockquote>\n<p>', inlineStr(kept.join('\n'), env), '</p>\n</blockquote>\n');
      continue;
    } else if (MD_BLANK.test(line)) {
      i++;
      continue;
    }
    const bullet = c0 === 45 || c0 === 42 ? MD_BULLET.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? MD_ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrd = ordered !== null;
      const marker = isOrd ? MD_ORDERED : MD_BULLET;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrd ? m[2] : m[1])]);
          i++;
        } else if (MD_CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      let block = isOrd && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">\n` : `<${tag}>\n`;
      for (const parts of items) block += `<li>${inlineStr(parts.join('\n'), env)}</li>\n`;
      out.push(block, `</${tag}>\n`);
      continue;
    }
    const plines = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      plines.push(trimLine(lines[i]));
      i++;
    }
    const html = inlineStr(plines.join('\n'), env);
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ------------------------------------------------------------------ templates

// Node kinds in a parsed template tree.
const T_TEXT = 0;
const T_VAR = 1;
const T_RAW = 2;
const T_IF = 3;
const T_FOR = 4;
const T_INCLUDE = 5;

const TP_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TP_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TP_IF = /^if (not )?(\S+)$/;
const TP_INCLUDE = /^include "([a-z0-9-]+)"$/;
const TP_SPACES = /^[ \t]*$/;
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why, worded as the reference words it (it reaches the report). */
class TemplateError extends Error {}

function pathOf(name, text) {
  if (!TP_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** A template source's tokens: text, {{ }}, {{{ }}} and {% %}; a standalone {% %} tag's line is taken with it. */
function tokenizeTemplate(name, src) {
  const tokens = [];
  const len = src.length;
  let text = '';
  let i = 0;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = TP_SPACES.test(src.slice(lineStart, open)) && TP_SPACES.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** A template source parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  // Each frame's `body` is the array new nodes append to; an if frame retargets it at its else branch.
  const stack = [{ kind: 'root', body: root }];
  for (const tok of tokenizeTemplate(name, src)) {
    const frame = stack[stack.length - 1];
    if (tok.t === 'text') {
      frame.body.push({ k: T_TEXT, s: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      frame.body.push({ k: tok.t === 'var' ? T_VAR : T_RAW, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    let m;
    if ((m = TP_FOR.exec(tag)) !== null) {
      const node = { k: T_FOR, name: m[1], path: pathOf(name, m[2]), body: [], usesLoop: false };
      frame.body.push(node);
      stack.push({ kind: 'for', body: node.body, node });
    } else if ((m = TP_IF.exec(tag)) !== null) {
      const node = { k: T_IF, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
      frame.body.push(node);
      stack.push({ kind: 'if', body: node.then, node });
    } else if (tag === 'else') {
      if (frame.kind !== 'if' || frame.node.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      frame.node.els = [];
      frame.body = frame.node.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (frame.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
    } else if ((m = TP_INCLUDE.exec(tag)) !== null) {
      frame.body.push({ k: T_INCLUDE, name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root;
}

/**
 * Whether a node tree ever looks up `loop` as a path's first name, following includes into other templates.
 * A for loop whose body (includes and all) never does can skip building a loop record per element.
 */
function treeRefsLoop(nodes, templates, seen) {
  for (const n of nodes) {
    switch (n.k) {
      case T_VAR:
      case T_RAW:
      case T_IF:
      case T_FOR:
        if (n.path[0] === 'loop') return true;
        break;
      default:
        break;
    }
    if (n.k === T_IF) {
      if (treeRefsLoop(n.then, templates, seen)) return true;
      if (n.els !== null && treeRefsLoop(n.els, templates, seen)) return true;
    } else if (n.k === T_FOR) {
      if (treeRefsLoop(n.body, templates, seen)) return true;
    } else if (n.k === T_INCLUDE) {
      if (seen.has(n.name)) continue;
      seen.add(n.name);
      const t = templates.get(n.name);
      if (t !== undefined && treeRefsLoop(t, templates, seen)) return true;
    }
  }
  return false;
}

/** Mark every for node that needs a loop record (its body, or anything it includes, reads `loop`). */
function markLoopUse(nodes, templates) {
  for (const n of nodes) {
    if (n.k === T_FOR) {
      n.usesLoop = treeRefsLoop(n.body, templates, new Set());
      markLoopUse(n.body, templates);
    } else if (n.k === T_IF) {
      markLoopUse(n.then, templates);
      if (n.els !== null) markLoopUse(n.els, templates);
    }
  }
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const head = path[0];
  while (s !== null && !Object.hasOwn(s.vars, head)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[head];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope`, pieces pushed onto `out`. `ctx.templates` maps names to parsed trees. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.k) {
      case T_TEXT:
        out.push(n.s);
        break;
      case T_VAR:
        out.push(esc(textOf(lookup(scope, n.path))));
        break;
      case T_RAW:
        out.push(textOf(lookup(scope, n.path)));
        break;
      case T_IF: {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.els;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case T_FOR: {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        if (n.usesLoop || n.name === 'loop') {
          for (let k = 0; k < len; k++) {
            const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
            renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
          }
        } else {
          for (let k = 0; k < len; k++) {
            renderNodes(n.body, { vars: { [n.name]: xs[k] }, parent: scope }, ctx, depth, out);
          }
        }
        break;
      }
      case T_INCLUDE: {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ the build

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Code-unit order (never the locale's). */
function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dirOf(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/** `rel` from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A source's own tags: each slug once (the first spelling kept), in its own order. */
function ownTags(s) {
  const list = s.data.tags ?? [];
  const seen = new Set();
  const out = [];
  for (const name of list) {
    const slug = slugify(name);
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(name);
    }
  }
  return out;
}

/** One site's output tree: path -> text. The same build as makefun-site 1.0.0's, step for step. */
export function run(input) {
  // Templates first, in code-unit order of name; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  for (const nodes of templates.values()) markLoopUse(nodes, templates);

  const base = input.site.base_url.replace(/\/+$/, '');
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }

  // Front matter: a refused source is reported and dropped, and so is a draft. The checks run in the
  // reference's order: front matter, the generator's own directories, a post's date, its layout, draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug; each post's newer and older.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, each named as first met walking the posts in collection order, ordered by
  // count of posts, most first, then by slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, built once per source and shared by every list, page and tag that shows them.
  const cards = new Map();
  for (const s of kept) {
    cards.set(s, {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    });
  }
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const pageOf = (s) => ({
    ...cards.get(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page through its layout, then the index pages, the tag pages and the tags page,
  // then each static file at its own path unless a built page has that path.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.reduce((n, s) => n + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
