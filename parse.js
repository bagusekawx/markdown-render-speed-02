// parse.js — dependency-free CommonMark 0.31.2 + GFM renderer matching marked 18.1.3
// byte for byte (default options, GFM on). Written from scratch for the
// make.fun markdown-render-speed-02 bounty. Exports parse(markdown) -> HTML.
//
// Architecture: a line-based recursive block parser builds a small tree;
// inline parsing runs per text node at render time. Inline parsing uses a
// bracket stack for links (CommonMark) plus a delimiter stack for emphasis,
// but emphasis never spans link boundaries (marked tokenizes link text
// separately), and extended autolinks are suppressed inside link text.

// ---------------- char helpers ----------------

// ASCII punctuation lookup (CommonMark's set)
const ASCII_PUNCT = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') ASCII_PUNCT[ch.charCodeAt(0)] = 1;

const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCode(cp) {
  if (cp < 128) return ASCII_PUNCT[cp] === 1;
  return UNICODE_PUNCT_RE.test(String.fromCodePoint(cp));
}
// CommonMark whitespace: Zs category + tab, LF, FF, CR
function isSpaceCode(cp) {
  if (cp === 9 || cp === 10 || cp === 12 || cp === 13 || cp === 32) return true;
  if (cp === 0xa0 || cp === 0x1680 || cp === 0x202f || cp === 0x205f || cp === 0x3000) return true;
  if (cp >= 0x2000 && cp <= 0x200a) return true;
  return false;
}
// code point of the char ending at index i (i is exclusive end), -1 at start
function codeBefore(s, i) {
  if (i <= 0) return -1;
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return (h - 0xd800) * 0x400 + (c - 0xdc00) + 0x10000;
  }
  return c;
}
// code point of the char starting at index i, -1 at end
function codeAfter(s, i) {
  if (i >= s.length) return -1;
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const l = s.charCodeAt(i + 1);
    if (l >= 0xdc00 && l <= 0xdfff) return (c - 0xd800) * 0x400 + (l - 0xdc00) + 0x10000;
  }
  return c;
}

function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ---------------- escaping / entities ----------------

function escapeHtml(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (last < i) out += s.slice(last, i);
      out += rep;
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Does an entity pattern (&word; / &#dd; / &#xhh;) start at s[i] (s[i] === '&')?
// Returns the index just past the ';', or -1.
function entityPatternEnd(s, i) {
  let j = i + 1;
  if (s.charCodeAt(j) === 35) {
    j++;
    if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) j++;
    const st = j;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) break;
      j++;
    }
    if (j > st && s.charCodeAt(j) === 59) return j + 1;
    return -1;
  }
  const st = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) break;
    j++;
  }
  if (j > st && s.charCodeAt(j) === 59) return j + 1;
  return -1;
}

// Escape for attribute values (href/title): & only when NOT part of an entity
// pattern; < > " ' always.
function escapeAttr(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      if (entityPatternEnd(s, i) !== -1) continue;
      if (last < i) out += s.slice(last, i);
      out += '&amp;';
      last = i + 1;
    } else if (c === 60) {
      if (last < i) out += s.slice(last, i);
      out += '&lt;';
      last = i + 1;
    } else if (c === 62) {
      if (last < i) out += s.slice(last, i);
      out += '&gt;';
      last = i + 1;
    } else if (c === 34) {
      if (last < i) out += s.slice(last, i);
      out += '&quot;';
      last = i + 1;
    } else if (c === 39) {
      if (last < i) out += s.slice(last, i);
      out += '&#39;';
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Parse an entity at src[i] === '&'. Returns {end, html} or null.
// Named entities pass through verbatim (marked does not validate them);
// numeric entities are decoded (0, surrogates, >0x10FFFF -> U+FFFD) and the
// resulting char is HTML-escaped. 8+ decimal / 7+ hex digits -> not an entity.
function parseEntity(src, i) {
  let j = i + 1;
  if (src.charCodeAt(j) === 35) {
    j++;
    let hex = false;
    if (src.charCodeAt(j) === 120 || src.charCodeAt(j) === 88) { hex = true; j++; }
    const st = j;
    let digits = 0;
    while (j < src.length && digits < 8) {
      const c = src.charCodeAt(j);
      const ok = hex
        ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
        : c >= 48 && c <= 57;
      if (!ok) break;
      j++;
      digits++;
    }
    if (digits === 0) return null;
    if (src.charCodeAt(j) !== 59) return null;
    if ((!hex && digits > 7) || (hex && digits > 6)) return null;
    const num = parseInt(src.slice(st, j), hex ? 16 : 10);
    let ch;
    if (num === 0 || num > 0x10ffff || (num >= 0xd800 && num <= 0xdfff)) ch = '\uFFFD';
    else ch = String.fromCodePoint(num);
    return { end: j + 1, html: escapeHtml(ch), ch };
  }
  let k = j;
  while (k < src.length && k - i <= 34) {
    const c = src.charCodeAt(k);
    if (c === 59) {
      if (k === j) return null;
      return { end: k + 1, html: src.slice(i, k + 1), ch: null };
    }
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) return null;
    k++;
  }
  return null;
}

// Process backslash escapes and entities in a link destination or title,
// returning the decoded string (entities stay verbatim if named, decoded if
// numeric; backslash + ASCII punctuation -> the punctuation).
function decodeLinkText(s) {
  if (s.indexOf('\\') === -1 && s.indexOf('&') === -1) return s;
  let out = '';
  let last = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) < 128 && ASCII_PUNCT[s.charCodeAt(i + 1)] === 1) {
      if (last < i) out += s.slice(last, i);
      out += s[i + 1];
      i += 2;
      last = i;
      continue;
    }
    if (c === 38) {
      const e = parseEntity(s, i);
      if (e) {
        if (last < i) out += s.slice(last, i);
        // named: keep verbatim text; numeric: the decoded char
        out += e.ch !== null ? e.ch : s.slice(i, e.end);
        i = e.end;
        last = i;
        continue;
      }
    }
    i++;
  }
  return last === 0 ? s : out + s.slice(last);
}

function isHexDigit(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }
function pctByte(b) { const h = b.toString(16).toUpperCase(); return '%' + (h.length === 1 ? '0' + h : h); }
// encodeURI-like, but a valid %XX sequence is kept as-is (marked behaviour:
// encodeURI itself turns % into %25, which is wrong for %20 in a destination).
function encodeHref(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // '%' is passed through as-is (encodeURI semantics: a bare '%' is not
    // encoded, and a valid %XX sequence is kept)
    if (c === 37) { out += '%'; continue; }
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
        c === 59 || c === 44 || c === 47 || c === 63 || c === 58 || c === 64 || c === 38 ||
        c === 61 || c === 43 || c === 36 || c === 45 || c === 95 || c === 46 || c === 33 ||
        c === 126 || c === 42 || c === 39 || c === 40 || c === 41 || c === 35) {
      out += s[i]; continue;
    }
    const cp = s.codePointAt(i);
    if (cp > 0xFFFF) i++;
    if (cp >= 0xD800 && cp <= 0xDFFF) { out += s[i]; continue; } // lone surrogate: raw
    if (cp < 0x80) out += pctByte(cp);
    else if (cp < 0x800) out += pctByte(0xC0 | (cp >> 6)) + pctByte(0x80 | (cp & 0x3F));
    else if (cp < 0x10000) out += pctByte(0xE0 | (cp >> 12)) + pctByte(0x80 | ((cp >> 6) & 0x3F)) + pctByte(0x80 | (cp & 0x3F));
    else out += pctByte(0xF0 | (cp >> 18)) + pctByte(0x80 | ((cp >> 12) & 0x3F)) + pctByte(0x80 | ((cp >> 6) & 0x3F)) + pctByte(0x80 | (cp & 0x3F));
  }
  return out;
}

// Clean a link destination into an href attribute value.
function cleanUrl(dest) {
  return escapeAttr(encodeHref(decodeLinkText(dest)));
}

// Clean an autolink URL: NO backslash/entity decoding (the raw URL is
// percent-encoded as-is; \< in an autolink stays a backslash -> %5C).
function cleanUrlRaw(dest) {
  return escapeAttr(encodeHref(dest));
}

// Clean a link title into a title attribute value.
function cleanTitle(title) {
  return escapeAttr(decodeLinkText(title));
}

// Normalize a link label: collapse whitespace runs to one space, trim, lowercase.
function normalizeLabel(s) {
  let out = '';
  let lastWs = true; // trims leading whitespace
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      if (!lastWs) { out += ' '; lastWs = true; }
    } else {
      out += s[i];
      lastWs = false;
    }
  }
  if (lastWs && out.length > 0) out = out.slice(0, -1);
  // Unicode case folding: ẞ/ß fold to "ss" (toLowerCase gives ß for ẞ)
  return out.toLowerCase().replace(/ß/g, 'ss');
}

// Resolve backslash escapes (backslash + ASCII punctuation -> the punct).
function unescapeBackslashes(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) < 128 && ASCII_PUNCT[s.charCodeAt(i + 1)] === 1) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// ---------------- inline parsing ----------------

// Inline node types:
// 0 text {s} · 1 delimiter {ch, len, open, close, s} · 2 link {href, title, ch}
// 3 image {href, title, ch} · 4 code {s} · 5 raw html {s} · 6 hard break
// 7 autolink {href, text} · 8 entity {s} · 9 em/strong/del {tag, ch} · 10 container {ch}
// Every node carries .p (parent). Containers carry .ob (openersBottom map).

function makeNode(t) { return { t, p: null, ch: null, s: null }; }

function parseInline(src, refs) {
  const N = src.length;
  const root = makeNode(10);
  root.ch = [];
  const delims = []; // delimiter records in document order
  const brackets = []; // link openers: {n, img, active}
  let activeBrackets = 0; // count of active brackets (avoids .some() scans)
  let buf = '';
  let i = 0;

  function flushText() {
    if (buf !== '') {
      const n = makeNode(0);
      n.s = buf;
      n.p = root;
      root.ch.push(n);
      buf = '';
    }
  }

  // Try to parse a link/image suffix starting at src[i] (just after ']').
  // Returns {end, href, title} or null. Consumes the suffix from the source.
  function parseLinkSuffix(pos) {
    // inline link: ( dest "title" )
    if (src.charCodeAt(pos) === 40) {
      let j = pos + 1;
      // skip whitespace (incl. newlines)
      while (j < N) {
        const c = src.charCodeAt(j);
        if (c === 32 || c === 9 || c === 10) j++;
        else break;
      }
      let dest = '';
      if (j < N && src.charCodeAt(j) === 60) {
        // <...> destination: no line endings, no unescaped < >
        let k = j + 1;
        let ok = false;
        while (k < N) {
          const c = src.charCodeAt(k);
          if (c === 62) { ok = true; break; }
          if (c === 10 || c === 60) break;
          if (c === 92 && k + 1 < N && src.charCodeAt(k + 1) < 128 && ASCII_PUNCT[src.charCodeAt(k + 1)] === 1) { k += 2; continue; }
          k++;
        }
        if (!ok) return null;
        dest = src.slice(j + 1, k);
        j = k + 1;
      } else {
        // bare destination: no spaces, balanced parens
        let k = j;
        let depth = 0;
        while (k < N) {
          const c = src.charCodeAt(k);
          if (c === 32 || c === 9 || c === 10) break;
          if (c === 92 && k + 1 < N && src.charCodeAt(k + 1) < 128 && ASCII_PUNCT[src.charCodeAt(k + 1)] === 1) { k += 2; continue; }
          if (c === 40) { depth++; k++; continue; }
          if (c === 41) {
            if (depth === 0) break;
            depth--;
            k++;
            continue;
          }
          if (c < 32 || c === 127) break;
          k++;
        }
        dest = src.slice(j, k);
        j = k;
      }
      // skip whitespace
      let j2 = j;
      while (j2 < N) {
        const c = src.charCodeAt(j2);
        if (c === 32 || c === 9 || c === 10) j2++;
        else break;
      }
      let title = null;
      if (j2 < N && src.charCodeAt(j2) !== 41) {
        // title?
        const q = src.charCodeAt(j2);
        let tEnd = -1;
        let tContent = '';
        if (q === 39 || q === 34) {
          let k = j2 + 1;
          while (k < N) {
            const c = src.charCodeAt(k);
            if (c === q) { tEnd = k + 1; tContent = src.slice(j2 + 1, k); break; }
            if (c === 92 && k + 1 < N && src.charCodeAt(k + 1) < 128 && ASCII_PUNCT[src.charCodeAt(k + 1)] === 1) { k += 2; continue; }
            k++;
          }
        } else if (q === 40) {
          let k = j2 + 1;
          let depth = 0;
          while (k < N) {
            const c = src.charCodeAt(k);
            if (c === 40) { depth++; k++; continue; }
            if (c === 41) {
              if (depth === 0) { tEnd = k + 1; tContent = src.slice(j2 + 1, k); break; }
              depth--;
              k++;
              continue;
            }
            if (c === 92 && k + 1 < N && src.charCodeAt(k + 1) < 128 && ASCII_PUNCT[src.charCodeAt(k + 1)] === 1) { k += 2; continue; }
            k++;
          }
        }
        if (tEnd === -1) return null;
        title = tContent;
        j2 = tEnd;
        while (j2 < N) {
          const c = src.charCodeAt(j2);
          if (c === 32 || c === 9 || c === 10) j2++;
          else break;
        }
      }
      if (j2 >= N || src.charCodeAt(j2) !== 41) return null;
      return { end: j2 + 1, href: cleanUrl(dest), title: title === null ? null : cleanTitle(title) };
    }
    // reference link: [label] or [] (collapsed)
    if (src.charCodeAt(pos) === 91) {
      let k = pos + 1;
      let depth = 0;
      let label = null;
      while (k < N) {
        const c = src.charCodeAt(k);
        if (c === 92 && k + 1 < N && src.charCodeAt(k + 1) < 128 && ASCII_PUNCT[src.charCodeAt(k + 1)] === 1) { k += 2; continue; }
        if (c === 91) { depth++; k++; continue; }
        if (c === 93) {
          if (depth === 0) { label = src.slice(pos + 1, k); k++; break; }
          depth--;
          k++;
          continue;
        }
        if (c === 10) { /* labels may span lines */ k++; continue; }
        k++;
      }
      if (label === null) return null;
      if (label.length > 999) return null;
      return { end: k, refLabel: normalizeLabel(label), collapsed: label === '' };
    }
    // shortcut reference link
    return { end: pos, refLabel: null, shortcut: true };
  }

  // Try to match an inline HTML tag at src[i] === '<'. Returns end index or -1.
  function matchHtmlTag(pos) {
    // comment: "<!-->" and "<!--->" are complete (empty) comments
    if (src.startsWith('<!-->', pos)) return pos + 5;
    if (src.startsWith('<!--->', pos)) return pos + 6;
    if (src.startsWith('<!--', pos)) {
      const e = src.indexOf('-->', pos + 4);
      return e === -1 ? -1 : e + 3;
    }
    if (src.startsWith('<?', pos)) {
      const e = src.indexOf('?>', pos + 2);
      return e === -1 ? -1 : e + 2;
    }
    if (src.startsWith('<![CDATA[', pos)) {
      const e = src.indexOf(']]>', pos + 9);
      return e === -1 ? -1 : e + 3;
    }
    if (src.startsWith('<!', pos)) {
      // declaration: <! + letter, up to >
      let j = pos + 2;
      const c = src.charCodeAt(j);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return -1;
      while (j < N) {
        if (src.charCodeAt(j) === 62) return j + 1;
        j++;
      }
      return -1;
    }
    // open / close tag
    let j = pos + 1;
    let closing = false;
    if (src.charCodeAt(j) === 47) { closing = true; j++; }
    const nameStart = j;
    const c0 = src.charCodeAt(j);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
    j++;
    while (j < N) {
      const c = src.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) j++;
      else break;
    }
    if (j === nameStart) return -1;
    // a closing tag cannot have attributes: only whitespace then '>'
    if (closing) {
      while (j < N) {
        const c = src.charCodeAt(j);
        if (c === 32 || c === 9 || c === 10) j++;
        else break;
      }
      return j < N && src.charCodeAt(j) === 62 ? j + 1 : -1;
    }
    // attributes / close: an attribute must be preceded by whitespace.
    // Whitespace skipped before the '=' check counts as the separator for
    // the NEXT attribute (a valueless attribute like "_boolean" is followed
    // by a space, then the next attribute).
    let hadWs = false;
    while (j < N) {
      // skip whitespace
      const wsStart = j;
      while (j < N) {
        const c = src.charCodeAt(j);
        if (c === 32 || c === 9 || c === 10) j++;
        else break;
      }
      if (j > wsStart) hadWs = true;
      if (j >= N) return -1;
      const c = src.charCodeAt(j);
      if (c === 62) return j + 1;
      if (c === 47) {
        if (src.charCodeAt(j + 1) === 62) return j + 2;
        return -1;
      }
      if (!hadWs) return -1; // attribute without preceding whitespace
      hadWs = false;
      // attribute name
      const aStart = j;
      const ac = src.charCodeAt(j);
      if (!((ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || ac === 95 || ac === 58)) return -1;
      j++;
      while (j < N) {
        const cc = src.charCodeAt(j);
        if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 95 || cc === 58 || cc === 45 || cc === 46) j++;
        else break;
      }
      if (j === aStart) return -1;
      // skip whitespace (before a possible '=')
      const ws2 = j;
      while (j < N) {
        const cc = src.charCodeAt(j);
        if (cc === 32 || cc === 9 || cc === 10) j++;
        else break;
      }
      if (j > ws2) hadWs = true;
      if (j < N && src.charCodeAt(j) === 61) {
        j++;
        while (j < N) {
          const cc = src.charCodeAt(j);
          if (cc === 32 || cc === 9 || cc === 10) j++;
          else break;
        }
        if (j >= N) return -1;
        const q = src.charCodeAt(j);
        if (q === 34 || q === 39) {
          j++;
          while (j < N && src.charCodeAt(j) !== q) j++;
          if (j >= N) return -1;
          j++;
        } else {
          // unquoted value: no spaces, ", ', =, <, >, `
          const vStart = j;
          while (j < N) {
            const cc = src.charCodeAt(j);
            if (cc === 32 || cc === 9 || cc === 10 || cc === 34 || cc === 39 || cc === 61 || cc === 60 || cc === 62 || cc === 96) break;
            j++;
          }
          if (j === vStart) return -1;
        }
        hadWs = false; // after a value, the next attribute needs fresh whitespace
      }
    }
    return -1;
  }

  // Try to match an autolink <scheme:...> or <email> at src[i] === '<'.
  // Returns {end, href, text} or null.
  function matchAutolink(pos) {
    // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
    let j = pos + 1;
    const c0 = src.charCodeAt(j);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) {
      // maybe email
      return matchEmailAutolink(pos);
    }
    j++;
    let schemeLen = 1;
    while (j < N && schemeLen < 32) {
      const c = src.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 46 || c === 45) { j++; schemeLen++; }
      else break;
    }
    if (schemeLen >= 2 && src.charCodeAt(j) === 58) {
      // scan to '>' — no spaces or '<' allowed
      let k = j + 1;
      while (k < N) {
        const c = src.charCodeAt(k);
        if (c === 62) {
          const url = src.slice(pos + 1, k);
          return { end: k + 1, href: cleanUrlRaw(url), text: escapeHtml(url), raw: url };
        }
        if (c === 32 || c === 10 || c === 60) return null;
        k++;
      }
      return null;
    }
    return matchEmailAutolink(pos);
  }

  function matchEmailAutolink(pos) {
    // <local@domain> — local: [a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+
    let j = pos + 1;
    const localStart = j;
    while (j < N) {
      const c = src.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
          c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 ||
          c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 ||
          c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45) j++;
      else break;
    }
    if (j === localStart || src.charCodeAt(j) !== 64) return null;
    j++;
    const domStart = j;
    let lastDot = -1;
    let lastWasAlnum = false;
    while (j < N) {
      const c = src.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { lastWasAlnum = true; j++; continue; }
      if (c === 45) { lastWasAlnum = false; j++; continue; }
      if (c === 46) {
        if (!lastWasAlnum) return null;
        lastDot = j;
        lastWasAlnum = false;
        j++;
        continue;
      }
      break;
    }
    if (lastDot === -1 || !lastWasAlnum) return null;
    // TLD must contain a letter (after last dot)
    let hasLetter = false;
    for (let k = lastDot + 1; k < j; k++) {
      const c = src.charCodeAt(k);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { hasLetter = true; break; }
    }
    if (!hasLetter) return null;
    if (src.charCodeAt(j) !== 62) return null;
    const email = src.slice(pos + 1, j);
    return { end: j + 1, href: 'mailto:' + cleanUrlRaw(email), text: escapeHtml(email), raw: email };
  }

  // ---- GFM extended autolinks (www. / scheme:// / email) ----
  // Valid domain per GFM: labels of [a-zA-Z0-9_-] separated by '.', each label
  // not starting/ending with '-', containing at least one '.', last label has a letter.
  // Returns the end index of the domain (exclusive) or -1.
  function matchDomain(pos, forUrl) {
    let j = pos;
    let labels = 0;
    let lastDot = -1;
    while (j < N) {
      // label
      const ls = j;
      let hasAlnum = false;
      while (j < N) {
        const c = src.charCodeAt(j);
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) { hasAlnum = true; j++; }
        else if (c === 45) j++;
        else break;
      }
      if (j === ls) break;
      // label must not start or end with '-'
      if (src.charCodeAt(ls) === 45 || src.charCodeAt(j - 1) === 45) return -1;
      if (!hasAlnum) return -1;
      labels++;
      if (src.charCodeAt(j) === 46) {
        // '.' followed by a label char?
        const nc = src.charCodeAt(j + 1);
        if ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122) || nc === 95 || nc === 45) {
          lastDot = j;
          j++;
          continue;
        }
        break;
      }
      break;
    }
    // trailing '_' or '-' is not part of a URL domain (it is usually an
    // emphasis delimiter: "https://x.com__" links "x.com"). For email
    // domains there is no path after, so a trailing '_' invalidates the
    // whole email ("a.b-c_d@a.b_" does not link at all).
    if (forUrl) {
      while (j > pos && (src.charCodeAt(j - 1) === 95 || src.charCodeAt(j - 1) === 45)) j--;
    }
    if (labels < 2 || lastDot === -1) return -1;
    // last label must contain a letter and end with an alphanumeric
    // ("a.b_" is not a valid domain)
    let hasLetter = false;
    for (let k = lastDot + 1; k < j; k++) {
      const c = src.charCodeAt(k);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { hasLetter = true; break; }
    }
    if (!hasLetter) return -1;
    const lastC = src.charCodeAt(j - 1);
    if (!((lastC >= 48 && lastC <= 57) || (lastC >= 65 && lastC <= 90) || (lastC >= 97 && lastC <= 122))) return -1;
    return j;
  }

  // After a domain, consume an optional path: any chars except whitespace and
  // '<', with balanced parens and trailing-punctuation rules (GFM).
  // Returns the end index of the whole autolink.
  function matchAutolinkPath(pos, urlStart) {
    let j = pos;
    let parenDepth = 0;
    // a ']' ends the path when it closes an active [ ... ] region and is
    // followed by a link suffix — unless the autolink sits inside a link
    // destination "(...)" (preceded by "]("): then the ']' is URL content
    // but still ends the path ("](https://x)]" links "https://x)]").
    // A '(' that is literal link text ("[path (https://x)]") does NOT
    // count: the link must still form.
    const inParens = urlStart > 1 && src.charCodeAt(urlStart - 1) === 40 && src.charCodeAt(urlStart - 2) === 93;
    const inBrackets = !inParens && activeBrackets > 0;
    while (j < N) {
      const c = src.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 60) break;
      if (c === 93) {
        // ']' closes an active [ ... ] region: stop before it so the link
        // can form. Inside a (...) group the ']' is URL content but still
        // ends the path ("(https://x)]" links "https://x)]", not more).
        if (inBrackets && (src.charCodeAt(j + 1) === 40 || src.charCodeAt(j + 1) === 91)) break;
        if (inParens) { j++; break; }
      }
      if (c === 40) { parenDepth++; j++; continue; }
      if (c === 41) {
        // an unbalanced ')' in the middle of the path is content (it only
        // matters at the end, where it is trimmed below)
        if (parenDepth > 0) parenDepth--;
        j++;
        continue;
      }
      j++;
    }
    // a trailing ';' that forms an entity reference (&...;) ends the
    // autolink before the '&' — check this BEFORE trimming ';' as
    // punctuation ("www.google.com/search?q=commonmark&hl;" links only
    // up to "commonmark")
    let end = j;
    if (end > pos && src.charCodeAt(end - 1) === 59) {
      let k = end - 2;
      while (k >= pos && ((src.charCodeAt(k) >= 48 && src.charCodeAt(k) <= 57) || (src.charCodeAt(k) >= 65 && src.charCodeAt(k) <= 90) || (src.charCodeAt(k) >= 97 && src.charCodeAt(k) <= 122))) k--;
      if (k >= pos && src.charCodeAt(k) === 38) end = k;
    }
    // trim trailing punctuation and unbalanced ')', alternating until stable
    // ("(https://x/y)?" loses the "?" then the ")")
    for (;;) {
      let changed = false;
      while (end > pos) {
        const c = src.charCodeAt(end - 1);
        if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 42 || c === 95 || c === 126 || c === 59) { end--; changed = true; }
        else break;
      }
      // trim a trailing ')' only if it has no matching '(' before it
      // (scan the depth up to that ')', not the total depth: the first ')'
      // in "a)b(c)" is unbalanced but the last one is matched)
      while (end > pos && src.charCodeAt(end - 1) === 41) {
        let depth = 0;
        for (let k = pos; k < end - 1; k++) {
          const c = src.charCodeAt(k);
          if (c === 40) depth++;
          else if (c === 41) depth--;
        }
        if (depth <= 0) { end--; changed = true; }
        else break;
      }
      if (!changed) break;
    }
    return end;
  }

  // Try an extended autolink starting at pos (word boundary already checked).
  // Returns {end, href, text} or null.
  function matchExtendedAutolink(pos) {
    // www.
    if (src.startsWith('www.', pos)) {
      const dEnd = matchDomain(pos + 4, true);
      if (dEnd === -1) return null;
      const end = matchAutolinkPath(dEnd, pos);
      const text = src.slice(pos, end);
      return { end, href: 'http://' + cleanUrl(text), text: escapeHtml(text), raw: text };
    }
    // scheme:// — http, https, ftp (case-insensitive: "Https://" links)
    let schemeEnd = -1;
    const lower8 = src.slice(pos, pos + 8).toLowerCase();
    if (lower8.startsWith('http://')) schemeEnd = pos + 7;
    else if (lower8.startsWith('https://')) schemeEnd = pos + 8;
    else if (src.slice(pos, pos + 6).toLowerCase() === 'ftp://') schemeEnd = pos + 6;
    if (schemeEnd !== -1) {
      const dEnd = matchDomain(schemeEnd, true);
      if (dEnd === -1) return null;
      const end = matchAutolinkPath(dEnd, pos);
      const text = src.slice(pos, end);
      return { end, href: cleanUrl(text), text: escapeHtml(text), raw: text };
    }
    // bare scheme: mailto: / xmpp: / any scheme — scheme (2-32 chars) + ':'
    // + an email or domain, plus at most one path segment
    let j = pos;
    const c0 = src.charCodeAt(j);
    if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
      j++;
      let schemeLen = 1;
      while (j < N && schemeLen < 32) {
        const c = src.charCodeAt(j);
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 46 || c === 45) { j++; schemeLen++; }
        else break;
      }
      if (schemeLen >= 2 && src.charCodeAt(j) === 58) {
        // after ':': an email (local@domain) or a bare domain
        let k = j + 1;
        // try email first: local part then '@' then domain
        let ls = k;
        while (ls < N) {
          const c = src.charCodeAt(ls);
          if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
              c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 ||
              c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 ||
              c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45) ls++;
          else break;
        }
        let dEnd = -1;
        let sawAt = false;
        if (ls > k && src.charCodeAt(ls) === 64) {
          sawAt = true;
          const local = src.slice(k, ls);
          if (local.charCodeAt(0) !== 46 && local.charCodeAt(local.length - 1) !== 46 && local.indexOf('..') === -1) {
            dEnd = matchDomain(ls + 1);
          }
        }
        // if it looked like an email (had '@') but the domain was invalid,
        // there is no autolink (don't match the local part as a domain)
        if (dEnd === -1 && sawAt) return null;
        if (dEnd === -1) dEnd = matchDomain(k, true);
        if (dEnd !== -1) {
          let end = dEnd;
          // at most one path segment: '/' + chars (no '/', whitespace, '<')
          if (src.charCodeAt(end) === 47) {
            let p = end + 1;
            let segEnd = p;
            while (segEnd < N) {
              const c = src.charCodeAt(segEnd);
              if (c === 32 || c === 9 || c === 10 || c === 60 || c === 47) break;
              segEnd++;
            }
            if (segEnd > p) end = segEnd;
          }
          // trim trailing punctuation (same rules as a path)
          while (end > dEnd) {
            const c = src.charCodeAt(end - 1);
            if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 42 || c === 95 || c === 126) end--;
            else break;
          }
          const text = src.slice(pos, end);
          return { end, href: cleanUrl(text), text: escapeHtml(text), raw: text };
        }
      }
    }
    return null;
  }

  // Email autolink ending at the '@' at position atPos: scan the local part
  // back out of the SOURCE (not the buffer: a backslash escape in the
  // source, e.g. "foo\+@", is not a valid local part even though the
  // buffer holds "foo+"). Returns {start, end, href, text} or null, where
  // start is an index into buf (chars to remove from the buffer's end).
  function matchEmailFromBuffer(atPos) {
    // local part: [a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+ immediately before '@'
    let ls = atPos;
    while (ls > 0) {
      const c = src.charCodeAt(ls - 1);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
          c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 ||
          c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 ||
          c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45) ls--;
      else break;
    }
    if (ls === atPos) return null;
    const local = src.slice(ls, atPos);
    // a backslash right before the local part means its first char was
    // escaped ("foo\+@..." is not an email)
    if (ls > 0 && src.charCodeAt(ls - 1) === 92) return null;
    // local must not start/end with '.', no '..'
    if (local.charCodeAt(0) === 46 || local.charCodeAt(local.length - 1) === 46) return null;
    if (local.indexOf('..') !== -1) return null;
    const dEnd = matchDomain(atPos + 1);
    if (dEnd === -1) return null;
    const email = local + '@' + src.slice(atPos + 1, dEnd);
    return { localLen: local.length, end: dEnd, href: 'mailto:' + cleanUrl(email), text: escapeHtml(email), raw: email };
  }

  // Remove n characters from the end of the accumulated output (buffer
  // first, then text/delimiter nodes backwards). Used when an email
  // autolink's local part contains '_' delimiters that were already
  // tokenized.
  function removeTrailingChars(n) {
    if (buf.length >= n) {
      buf = buf.slice(0, buf.length - n);
      return;
    }
    n -= buf.length;
    buf = '';
    while (n > 0 && root.ch.length > 0) {
      const last = root.ch[root.ch.length - 1];
      if (last.t !== 0 && last.t !== 1) break;
      const s = last.s;
      if (s.length <= n) {
        n -= s.length;
        root.ch.pop();
        if (last.t === 1) {
          const di = delims.indexOf(last);
          if (di !== -1) delims.splice(di, 1);
        }
      } else {
        last.s = s.slice(0, s.length - n);
        if (last.t === 1) last.len = last.s.length;
        n = 0;
      }
    }
  }

  // Is there an active (unmatched) link opener? (Kept for reference; the
  // extended-autolink suppression is now done by reverting nodes when a
  // link forms, so this is unused by the scanner.)
  function insideLinkText() {
    for (let b = brackets.length - 1; b >= 0; b--) {
      if (brackets[b].active) return true;
    }
    return false;
  }

  // ---- main scan ----
  while (i < N) {
    const c = src.charCodeAt(i);

    // backslash
    if (c === 92) {
      if (i + 1 < N) {
        const n = src.charCodeAt(i + 1);
        if (n === 10) {
          flushText();
          const br = makeNode(6);
          br.p = root;
          root.ch.push(br);
          i += 2;
          // leading whitespace on the line after a hard break is stripped
          while (i < N && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
          continue;
        }
        if (n < 128 && ASCII_PUNCT[n] === 1) {
          buf += src[i + 1];
          i += 2;
          continue;
        }
      }
      buf += '\\';
      i++;
      continue;
    }

    // code span
    if (c === 96) {
      let j = i;
      while (j < N && src.charCodeAt(j) === 96) j++;
      const run = j - i;
      let k = j;
      let found = -1;
      const hasActiveBracket = activeBrackets > 0;
      while (k < N) {
        const nb = src.indexOf('`', k);
        if (nb === -1) break;
        // a code span inside link text cannot span a newline to find its
        // closer ("[docs each ``url`](...)" — the next "``" is on a later
        // line, so the "``" stays literal and the link forms). On the same
        // line it CAN cross ']' ("[not a `link](/foo`)" is a code span).
        if (hasActiveBracket) {
          const nl = src.indexOf('\n', k);
          if (nl !== -1 && nl < nb) break;
        }
        let e = nb;
        while (e < N && src.charCodeAt(e) === 96) e++;
        if (e - nb === run) { found = nb; break; }
        k = e;
      }
      if (found !== -1) {
        let content = src.slice(j, found);
        if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32) {
          let allSpaces = true;
          for (let q = 0; q < content.length; q++) {
            if (content.charCodeAt(q) !== 32) { allSpaces = false; break; }
          }
          if (!allSpaces) content = content.slice(1, -1);
        }
        flushText();
        const cn = makeNode(4);
        cn.s = content;
        cn.p = root;
        root.ch.push(cn);
        i = found + run;
        continue;
      }
      buf += src.slice(i, j);
      i = j;
      continue;
    }

    // emphasis / strikethrough delimiters
    if (c === 42 || c === 95 || c === 126) {
      let j = i;
      while (j < N && src.charCodeAt(j) === c) j++;
      const run = j - i;
      // strikethrough: runs of 3+ tildes are literal
      if (c === 126 && run >= 3) {
        buf += src.slice(i, j);
        i = j;
        continue;
      }
      const beforeCp = codeBefore(src, i);
      const afterCp = codeAfter(src, j);
      const beforeWs = beforeCp === -1 || isSpaceCode(beforeCp);
      const afterWs = afterCp === -1 || isSpaceCode(afterCp);
      const beforePunct = beforeCp !== -1 && isPunctCode(beforeCp);
      const afterPunct = afterCp !== -1 && isPunctCode(afterCp);
      const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen, canClose;
      if (c === 95) {
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      flushText();
      const dn = makeNode(1);
      dn.ch = c;
      dn.len = run;
      dn.open = canOpen;
      dn.close = canClose;
      dn.s = src.slice(i, j);
      dn.p = root;
      root.ch.push(dn);
      delims.push({ n: dn, ch: c, len: run, open: canOpen, close: canClose });
      i = j;
      continue;
    }

    // link / image opener
    if (c === 91 || (c === 33 && src.charCodeAt(i + 1) === 91)) {
      const isImg = c === 33;
      // nested [ openers are recorded normally; the bracket algorithm
      // (an inner link removes preceding non-image openers) enforces
      // "a link cannot contain a link".
      flushText();
      const bn = makeNode(0);
      bn.s = isImg ? '![' : '[';
      bn.p = root;
      // raw source position where the link text starts (labels are read
      // from the raw source, so backslash escapes stay significant)
      bn.srcStart = i + (isImg ? 2 : 1);
      root.ch.push(bn);
      brackets.push({ n: bn, img: isImg, active: true });
      activeBrackets++;
      i += isImg ? 2 : 1;
      continue;
    }

    // link / image closer
    if (c === 93) {
      // find nearest active opener
      let bi = -1;
      for (let b = brackets.length - 1; b >= 0; b--) {
        if (brackets[b].active) { bi = b; break; }
      }
      if (bi === -1) {
        buf += ']';
        i++;
        continue;
      }
      const opener = brackets[bi];
      const suffix = parseLinkSuffix(i + 1);
      let href = null;
      let title = null;
      let endPos = -1;
      // the shortcut/collapsed label is read from the raw source, so the
      // buffered text must be flushed first (else the label comes out empty).
      flushText();
      if (suffix === null) {
        // the suffix failed to parse (e.g. "[foo](not a link)" — a bare
        // destination with spaces): fall back to a shortcut reference link
        // using the link text as the label
        const label = normalizeLabel(src.slice(opener.n.srcStart, i));
        const ref = refs.get(label);
        if (ref) {
          href = ref.href;
          title = ref.title;
          endPos = i + 1;
        }
      } else if (suffix.href !== undefined) {
        href = suffix.href;
        title = suffix.title;
        endPos = suffix.end;
      } else {
          // reference link: resolve the label
          let label;
          if (suffix.shortcut || suffix.collapsed) {
            // label = the raw link text between [ and ] (escapes preserved:
            // "[foo\!]" must NOT match a "[foo!]" definition)
            label = normalizeLabel(src.slice(opener.n.srcStart, i));
          } else {
            label = suffix.refLabel;
          }
          const ref = refs.get(label);
          if (ref) {
            href = ref.href;
            title = ref.title;
            endPos = suffix.end;
          }
        }
      // marked quirk: if the link text contains a code span whose content
      // includes a backtick ("`` a ` b ``") AND there is content after
      // that code span, an inline or full-reference link does NOT form
      // ("[a `` b ` c `` d](/url)" stays literal). If the code span is the
      // last thing in the text ("[a `` b ` c ``][x]"), the link forms.
      // Shortcut links are unaffected.
      if (href !== null && suffix !== null && !(suffix.shortcut || suffix.collapsed)) {
        const kids = root.ch;
        const oi = kids.indexOf(opener.n);
        let lastBt = -1;
        for (let q = oi + 1; q < kids.length; q++) {
          if (kids[q].t === 4 && kids[q].s.indexOf('`') !== -1) lastBt = q;
        }
        if (lastBt !== -1 && lastBt < kids.length - 1) href = null;
      }
      if (href === null) {
        // not a link: deactivate this opener, ']' is literal
        opener.active = false;
        activeBrackets--;
        // marked quirk: if the failed link text contains a code span with
        // a backtick inside, emphasis delimiters inside the "[...]" are
        // also suppressed ("[at _node `` a ` b ``_](<... b>)" keeps the
        // "_" literal, but "at _node `` a ` b ``_ end" forms <em>)
        const kids = root.ch;
        const oi = kids.indexOf(opener.n);
        let hasBt = false;
        for (let q = oi + 1; q < kids.length; q++) {
          if (kids[q].t === 4 && kids[q].s.indexOf('`') !== -1) { hasBt = true; break; }
        }
        if (hasBt) {
          for (const d of delims) {
            const di = kids.indexOf(d.n);
            if (di > oi) { d.open = false; d.close = false; }
          }
        }
        buf += ']';
        i++;
        continue;
      }
      // a link (not image) cannot contain a link: if the link text already
      // contains a link node, this opener fails (it stays in the stack only
      // as a deactivated opener, so an outer image can still match later)
      if (!opener.img) {
        flushText();
        const kids0 = root.ch;
        const oi0 = kids0.indexOf(opener.n);
        let hasLink = false;
        for (let q = oi0 + 1; q < kids0.length; q++) {
          if (kids0[q].t === 2) { hasLink = true; break; }
        }
        if (hasLink) {
          opener.active = false;
          activeBrackets--;
          buf += ']';
          i++;
          continue;
        }
      }
      // form the link/image
      flushText();
      const kids = root.ch;
      const oi = kids.indexOf(opener.n);
      const linkNode = makeNode(opener.img ? 3 : 2);
      linkNode.href = href;
      linkNode.title = title;
      linkNode.ch = [];
      linkNode.p = root;
      // move nodes after the opener into the link
      const moved = kids.splice(oi + 1);
      for (const m of moved) {
        m.p = linkNode;
        linkNode.ch.push(m);
      }
      // replace the opener node with the link node
      kids[oi] = linkNode;
      // remove the opener from the brackets stack
      brackets.splice(bi, 1);
      activeBrackets--;
      // extended autolinks inside link text are suppressed: any extended
      // autolink node created while scanning the link text reverts to plain
      // text. (<...> autolinks stay.)
      if (!opener.img) stripExtendedAutolinks(linkNode);
      i = endPos;
      continue;
    }

    // < : autolink or raw HTML
    if (c === 60) {
      const auto = matchAutolink(i);
      if (auto) {
        flushText();
        const an = makeNode(7);
        an.href = auto.href;
        an.text = auto.text;
        an.raw = auto.raw;
        an.p = root;
        root.ch.push(an);
        i = auto.end;
        continue;
      }
      const tagEnd = matchHtmlTag(i);
      if (tagEnd !== -1) {
        flushText();
        const hn = makeNode(5);
        hn.s = src.slice(i, tagEnd);
        hn.p = root;
        root.ch.push(hn);
        i = tagEnd;
        continue;
      }
      buf += '<';
      i++;
      continue;
    }

    // & : entity
    if (c === 38) {
      const e = parseEntity(src, i);
      if (e) {
        flushText();
        const en = makeNode(8);
        en.s = e.html;
        en.p = root;
        root.ch.push(en);
        i = e.end;
        continue;
      }
      buf += '&';
      i++;
      continue;
    }

    // newline: hard break (2+ trailing spaces) or soft break
    if (c === 10) {
      // count trailing spaces in buf
      let sp = 0;
      let q = buf.length;
      while (q > 0 && buf.charCodeAt(q - 1) === 32) { q--; sp++; }
      if (sp >= 2) {
        buf = buf.slice(0, q);
        flushText();
        const br = makeNode(6);
        br.p = root;
        root.ch.push(br);
        i++;
        // leading whitespace on the line after a hard break is stripped
        while (i < N && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }

    // extended autolinks: www. / scheme:// / bare scheme: at a word boundary
    // (parsed even inside [ ... ] regions; if the [ forms a link, the
    // autolink nodes inside it are reverted to plain text at that point)
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      const prevCp = codeBefore(src, i);
      // boundary: not alphanumeric and not a URL-continuation char
      // (a '.' before "www." is a domain separator, not a boundary; '<'
      // and other punctuation are boundaries)
      const atBoundary = prevCp === -1 || !(
        (prevCp >= 48 && prevCp <= 57) || (prevCp >= 65 && prevCp <= 90) || (prevCp >= 97 && prevCp <= 122) ||
        prevCp === 46 || prevCp === 47 || prevCp === 58 || prevCp === 63 || prevCp === 35 ||
        prevCp === 61 || prevCp === 38 || prevCp === 37 || prevCp === 43 || prevCp === 64);
      if (atBoundary) {
        const ext = matchExtendedAutolink(i);
        if (ext) {
          flushText();
          const an = makeNode(7);
          an.href = ext.href;
          an.text = ext.text;
          an.raw = ext.raw;
          an.ext = true;
          an.p = root;
          root.ch.push(an);
          i = ext.end;
          continue;
        }
      }
      buf += src[i];
      i++;
      continue;
    }

    // email autolink: '@' with a local part in the buffer
    if (c === 64) {
      const em = matchEmailFromBuffer(i);
      if (em) {
        removeTrailingChars(em.localLen);
        flushText();
        const an = makeNode(7);
        an.href = em.href;
        an.text = em.text;
        an.raw = em.raw;
        an.ext = true;
        an.p = root;
        root.ch.push(an);
        i = em.end;
        continue;
      }
      buf += '@';
      i++;
      continue;
    }

    // plain char
    buf += src[i];
    i++;
  }
  flushText();

  // ---- emphasis processing (per container: delimiters only match siblings) ----
  processEmphasis(delims);

  // ---- render ----
  const out = [];
  renderInlineChildren(root, out);
  return out.join('');
}

// Plain-text rendering of an inline node (for link labels and image alt text).
function inlinePlainText(node) {
  switch (node.t) {
    case 0: return node.s;
    case 1: return node.s;
    case 4: return node.s;
    case 5: return '';
    case 6: return '';
    case 7: return node.raw !== null && node.raw !== undefined ? node.raw : node.text;
    case 8: return node.s;
    case 2:
    case 3:
    case 9:
    case 10: {
      let s = '';
      const ch = node.ch || [];
      for (let k = 0; k < ch.length; k++) s += inlinePlainText(ch[k]);
      return s;
    }
    default: return '';
  }
}

// Revert extended-autolink nodes (www. / scheme:// / email) inside a link's
// children to plain text nodes. Recurses into image children (their alt text
// is plain text either way, but the node type must not survive as a link).
function stripExtendedAutolinks(node) {
  const ch = node.ch;
  if (!ch) return;
  for (let k = 0; k < ch.length; k++) {
    const m = ch[k];
    if (m.t === 7 && m.ext) {
      const tn = makeNode(0);
      tn.s = m.raw;
      tn.p = node;
      ch[k] = tn;
    } else if (m.ch) {
      stripExtendedAutolinks(m);
    }
  }
}

function processEmphasis(delims) {
  let di = 0;
  while (di < delims.length) {
    const closer = delims[di];
    if (!closer.close || closer.len === 0) { di++; continue; }
    const parent = closer.n.p;
    // find matching opener: nearest delimiter, same char, same parent, can open
    let opener = null;
    let oj = di - 1;
    const bottom = parent.ob ? parent.ob[closer.ch] : null;
    let sawPotential = false;
    while (oj >= 0) {
      const cand = delims[oj];
    // the openersBottom blocks only closers whose length differs from
    // the bottom opener's ORIGINAL length (before it was consumed):
    // "**a **b** c**" forms the outer strong (both "**"), but
    // "*a **b**c*" does not form the outer em ("*" vs "**")
    if (cand === bottom && closer.len !== (bottom.origLen !== undefined ? bottom.origLen : bottom.len)) break;
      if (cand.n.p !== parent || cand.ch !== closer.ch || !cand.open || cand.len === 0) { oj--; continue; }
      sawPotential = true;
      // odd-match rule: if either can both open and close, and the sum of the
      // lengths is a multiple of 3 (unless both are multiples of 3), no match
      if (((cand.open && cand.close) || (closer.open && closer.close)) &&
          ((cand.len + closer.len) % 3 === 0) &&
          !((cand.len % 3 === 0) && (closer.len % 3 === 0))) {
        oj--;
        continue;
      }
      opener = cand;
      break;
    }
    if (!opener) {
      if (!sawPotential) {
        if (!parent.ob) parent.ob = {};
        parent.ob[closer.ch] = di > 0 ? delims[di - 1] : null;
      }
      di++;
      continue;
    }
    const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
    const tag = closer.ch === 126 ? 'del' : (use === 1 ? 'em' : 'strong');
    const kids = parent.ch;
    const oi = kids.indexOf(opener.n);
    const ci = kids.indexOf(closer.n);
    // shorten the delimiter runs
    opener.len -= use;
    opener.n.s = opener.n.s.slice(0, opener.n.s.length - use);
    closer.len -= use;
    closer.n.s = closer.n.s.slice(use);
    // wrap the nodes between opener and closer
    const emph = makeNode(9);
    emph.tag = tag;
    emph.ch = [];
    emph.p = parent;
    const moved = kids.splice(oi + 1, ci - oi - 1);
    for (const m of moved) {
      m.p = emph;
      emph.ch.push(m);
    }
    kids.splice(oi + 1, 0, emph);
    // drop emptied delimiter nodes
    if (opener.len === 0) {
      const x = kids.indexOf(opener.n);
      if (x !== -1) kids.splice(x, 1);
    }
    if (closer.len === 0) {
      const x = kids.indexOf(closer.n);
      if (x !== -1) kids.splice(x, 1);
    }
    // if the closer can also open AND the opener cannot close AND this was
    // a strong match (2 delimiters), later closers may not match openers
    // at or below this one ("*a **b**c*" has no outer <em>; "*foo**bar**baz*"
    // does — its "**" opener can also close; "*state *types*updates*" does —
    // its inner match is em, not strong). Record the opener's pre-match
    // length: the bottom blocks only closers of a different length.
    if (closer.open && !opener.close && use === 2) {
      if (!parent.ob) parent.ob = {};
      if (opener.origLen === undefined) opener.origLen = opener.len + use;
      parent.ob[closer.ch] = opener;
    }
    if (closer.len === 0) di++; // else re-process this closer (it may match again)
  }
}

function renderInlineChildren(node, out) {
  const ch = node.ch || [];
  for (let k = 0; k < ch.length; k++) renderInlineNode(ch[k], out);
}

function renderInlineNode(node, out) {
  switch (node.t) {
    case 0:
      out.push(escapeHtml(node.s));
      break;
    case 1:
      out.push(node.s);
      break;
    case 2:
      out.push('<a href="', node.href, '"');
      if (node.title !== null && node.title !== undefined) out.push(' title="', node.title, '"');
      out.push('>');
      renderInlineChildren(node, out);
      out.push('</a>');
      break;
    case 3: {
      out.push('<img src="', node.href, '" alt="');
      let alt = '';
      const ch = node.ch || [];
      for (let k = 0; k < ch.length; k++) alt += inlinePlainText(ch[k]);
      out.push(escapeAttr(alt));
      if (node.title !== null && node.title !== undefined) out.push('" title="', node.title);
      out.push('">');
      break;
    }
    case 4:
      out.push('<code>', escapeHtml(node.s), '</code>');
      break;
    case 5:
      out.push(node.s);
      break;
    case 6:
      out.push('<br>');
      break;
    case 7:
      out.push('<a href="', node.href, '">', node.text, '</a>');
      break;
    case 8:
      out.push(node.s);
      break;
    case 9:
      out.push('<', node.tag, '>');
      renderInlineChildren(node, out);
      out.push('</', node.tag, '>');
      break;
    case 10:
      renderInlineChildren(node, out);
      break;
  }
}

// ---------------- block parsing ----------------

function splitLines(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  // a trailing newline does not create a final empty line
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Leading whitespace of line: {cols, idx} (tab-aware, tab stops every 4).
function measureIndent(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col, idx: i };
}

// Remove up to `cols` columns of leading whitespace. Returns {idx, spaces}
// where spaces is the remainder of a partially consumed tab (as spaces).
function stripColumns(line, cols) {
  let col = 0;
  let i = 0;
  let spaces = 0;
  while (i < line.length && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else { spaces = col + w - cols; col = cols; i++; }
    } else break;
  }
  return { idx: i, spaces };
}

// Strip `cols` columns of leading indent and return the remaining content
// as a string, with leading tabs expanded to spaces relative to their
// ORIGINAL columns (a tab after a stripped partial tab must still expand to
// its original tab stop). When keepTabs is true (code content), tabs that
// lie entirely past the strip boundary are kept as literal tabs instead of
// being expanded ("    \tfoo" in an indented code block keeps its tab).
function stripIndentStr(line, cols, keepTabs) {
  let ocol = 0; // column in the original line
  let i = 0;
  let out = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      if (ocol < cols) { ocol++; i++; }
      else if (keepTabs) break;
      else { out += ' '; ocol++; i++; }
    } else if (c === 9) {
      const w = 4 - (ocol % 4);
      if (ocol + w <= cols) { ocol += w; i++; }
      else if (ocol < cols) { out += ' '.repeat(ocol + w - cols); ocol += w; i++; if (keepTabs) break; }
      else if (keepTabs) break;
      else { out += ' '.repeat(w); ocol += w; i++; }
    } else {
      break;
    }
  }
  return out + line.slice(i);
}

// Block tag names for HTML block type 6 (CommonMark list).
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Match a fenced code block start. Returns {ch, len, info} or null.
function matchFence(line) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return null;
  const c = line.charCodeAt(ind.idx);
  if (c !== 96 && c !== 126) return null;
  let j = ind.idx;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  const len = j - ind.idx;
  if (len < 3) return null;
  const info = line.slice(j).trim();
  if (c === 96 && info.indexOf('`') !== -1) return null;
  return { ch: c, len, info, indent: ind.cols };
}

// Match an ATX heading. Returns {level, text} or null.
function matchATX(line) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return null;
  let j = ind.idx;
  let level = 0;
  while (j < line.length && line.charCodeAt(j) === 35 && level < 6) { j++; level++; }
  if (level === 0) return null;
  if (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  let text = line.slice(j).trim();
  // strip closing sequence of #s (preceded by space, only spaces after)
  if (text.length > 0) {
    let k = text.length;
    while (k > 0 && text.charCodeAt(k - 1) === 32) k--;
    let h = k;
    while (h > 0 && text.charCodeAt(h - 1) === 35) h--;
    if (h < k && h > 0 && text.charCodeAt(h - 1) === 32) {
      text = text.slice(0, h - 1).replace(/[ \t]+$/, '');
    } else if (h === 0 && k > 0) {
      // text is only hashes (e.g. "### ###") — the whole text is the
      // closing sequence, so the heading is empty
      text = '';
    }
  }
  return { level, text };
}

// Match a thematic break. Returns true/false.
function matchThematicBreak(line) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return false;
  let j = ind.idx;
  const c = line.charCodeAt(j);
  if (c !== 42 && c !== 45 && c !== 95) return false;
  let count = 0;
  while (j < line.length) {
    const cc = line.charCodeAt(j);
    if (cc === c) { count++; j++; }
    else if (cc === 32 || cc === 9) j++;
    else return false;
  }
  return count >= 3;
}

// Match a setext heading underline. Returns 1 (=) or 2 (-) or 0.
// The underline is a single run of = or - (no spaces inside), with only
// leading/trailing whitespace around it.
function matchSetext(line) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return 0;
  let j = ind.idx;
  const c = line.charCodeAt(j);
  if (c !== 61 && c !== 45) return 0;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j < line.length) return 0;
  return c === 61 ? 1 : 2;
}

// Match an HTML block start. Returns {type, endTag} or null.
// type 1: script/pre/style/textarea (endTag = closing marker)
// type 2: <!-- (end: -->) · type 3: <? (end: ?>) · type 4: <!letter (end: >)
// type 5: <![CDATA[ (end: ]]>) · type 6: block tag (end: blank line)
// type 7: complete tag alone on the line (end: blank line)
function matchHtmlBlockStart(line) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return null;
  if (line.charCodeAt(ind.idx) !== 60) return null;
  const rest = line.slice(ind.idx);
  const lower = rest.toLowerCase();
  // type 2
  if (lower.startsWith('<!--')) return { type: 2, end: '-->' };
  // type 3
  if (lower.startsWith('<?')) return { type: 3, end: '?>' };
  // type 5
  if (lower.startsWith('<![cdata[')) return { type: 5, end: ']]>' };
  // type 4
  if (lower.startsWith('<!')) {
    const c = lower.charCodeAt(2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return { type: 4, end: '>' };
  }
  // type 1: OPENING tags only (<script, <pre, <style, <textarea). A closing
  // tag like </pre> does NOT start an HTML block (pre is not a type-6 tag
  // either), so it stays paragraph content.
  for (const tag of ['script', 'pre', 'style', 'textarea']) {
    if (lower.startsWith('<' + tag)) {
      const afterIdx = 1 + tag.length;
      const after = afterIdx >= lower.length ? -1 : lower.charCodeAt(afterIdx);
      if (after === -1 || after === 32 || after === 9 || after === 62 || after === 10) {
        return { type: 1, end: '</' + tag };
      }
    }
  }
  // type 6 / 7: a tag
  let j = ind.idx + 1;
  let closing = false;
  if (line.charCodeAt(j) === 47) { closing = true; j++; }
  const nameStart = j;
  const c0 = line.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return null;
  j++;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) j++;
    else break;
  }
  const name = line.slice(nameStart, j).toLowerCase();
  const after = line.charCodeAt(j);
  const afterOk = j >= line.length || after === 32 || after === 9 || after === 62 || after === 47;
  if (BLOCK_TAGS.has(name) && afterOk) return { type: 6, end: null };
  // type 7: complete open or close tag, only whitespace after. The tag must
  // be fully valid (attributes need preceding whitespace and valid names;
  // a closing tag has no attributes) — "<a h*#ref>" and
  // "<a href='bar'title=title>" are not HTML blocks.
  if (afterOk) {
    let k = j;
    if (closing) {
      while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
      if (k < line.length && line.charCodeAt(k) === 62) {
        let m = k + 1;
        while (m < line.length && (line.charCodeAt(m) === 32 || line.charCodeAt(m) === 9)) m++;
        if (m >= line.length) return { type: 7, end: null };
      }
      return null;
    }
    while (k < line.length) {
      const wsStart = k;
      while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
      if (k >= line.length) return null;
      const c = line.charCodeAt(k);
      if (c === 62) {
        let m = k + 1;
        while (m < line.length && (line.charCodeAt(m) === 32 || line.charCodeAt(m) === 9)) m++;
        if (m >= line.length) return { type: 7, end: null };
        return null;
      }
      if (c === 47) {
        if (line.charCodeAt(k + 1) === 62) {
          let m = k + 2;
          while (m < line.length && (line.charCodeAt(m) === 32 || line.charCodeAt(m) === 9)) m++;
          if (m >= line.length) return { type: 7, end: null };
        }
        return null;
      }
      if (k === wsStart) return null;
      const aStart = k;
      const ac = line.charCodeAt(k);
      if (!((ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || ac === 95 || ac === 58)) return null;
      k++;
      while (k < line.length) {
        const cc = line.charCodeAt(k);
        if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 95 || cc === 58 || cc === 45 || cc === 46) k++;
        else break;
      }
      if (k === aStart) return null;
      while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
      if (k < line.length && line.charCodeAt(k) === 61) {
        k++;
        while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
        if (k >= line.length) return null;
        const q = line.charCodeAt(k);
        if (q === 34 || q === 39) {
          k++;
          while (k < line.length && line.charCodeAt(k) !== q) k++;
          if (k >= line.length) return null;
          k++;
        } else {
          const vStart = k;
          while (k < line.length) {
            const cc = line.charCodeAt(k);
            if (cc === 32 || cc === 9 || cc === 34 || cc === 39 || cc === 61 || cc === 60 || cc === 62 || cc === 96) break;
            k++;
          }
          if (k === vStart) return null;
        }
      }
    }
  }
  return null;
}

// Match a blockquote marker. Returns {idx, spaces} (content start) or null.
function matchQuoteMarker(line) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return null;
  if (line.charCodeAt(ind.idx) !== 62) return null;
  let i = ind.idx + 1;
  let spaces = 0;
  let col = ind.cols + 1; // column after '>'
  if (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { i++; col++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      spaces = w - 1;
      col += w;
      i++;
    }
  }
  // the remainder's leading tabs expand relative to their ORIGINAL columns
  // (">\t\tfoo" -> 2 spaces + a tab at col 4 -> 6 spaces + "foo")
  const rest = line.slice(i);
  let content = ' '.repeat(spaces);
  let k = 0;
  while (k < rest.length) {
    const ch = rest.charCodeAt(k);
    if (ch === 32) { content += ' '; col++; k++; }
    else if (ch === 9) { const w = 4 - (col % 4); content += ' '.repeat(w); col += w; k++; }
    else break;
  }
  content += rest.slice(k);
  return { idx: i, spaces, content };
}

// Match a list marker. Returns {bullet (char) | ordered {num, delim}, endIdx,
// contentIndent, empty} or null. endIdx = index just after the marker.
function matchListMarker(line) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return null;
  let j = ind.idx;
  const c = line.charCodeAt(j);
  let bullet = 0;
  let num = -1;
  let delim = 0;
  if (c === 45 || c === 43 || c === 42) {
    bullet = c;
    j++;
  } else if (c >= 48 && c <= 57) {
    let k = j;
    while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57 && k - j < 9) k++;
    if (k - j > 9) return null;
    const d = line.charCodeAt(k);
    if (d !== 46 && d !== 41) return null;
    num = parseInt(line.slice(j, k), 10);
    delim = d;
    j = k + 1;
  } else {
    return null;
  }
  // marker must be followed by space/tab/EOL
  if (j < line.length) {
    const nc = line.charCodeAt(j);
    if (nc !== 32 && nc !== 9) return null;
  }
  // content indent: marker width + following spaces (1-4; 5+ -> marker width + 1)
  // The separator is expanded to spaces (tabs are column-dependent); the part
  // beyond the content indent is content (contentPrefix), e.g. "1.     code"
  // has contentIndent 3 and contentPrefix "    " (indented code).
  let k = j;
  let spaces = 0;
  let col = ind.cols + (j - ind.idx); // column after the marker
  let sepExpanded = '';
  while (k < line.length) {
    const cc = line.charCodeAt(k);
    if (cc === 32) { spaces++; col++; sepExpanded += ' '; k++; }
    else if (cc === 9) { const w = 4 - (col % 4); spaces += w; col += w; sepExpanded += ' '.repeat(w); k++; }
    else break;
  }
  const empty = k >= line.length;
  const markerEndCol = ind.cols + (j - ind.idx);
  let contentIndent;
  if (empty) {
    contentIndent = markerEndCol + 1;
  } else if (spaces >= 1 && spaces <= 4) {
    contentIndent = col;
  } else {
    contentIndent = markerEndCol + 1;
  }
  const contentPrefix = empty ? '' : sepExpanded.slice(contentIndent - markerEndCol);
  return {
    bullet, num, delim,
    endIdx: j,
    contentStart: k,
    contentPrefix,
    contentIndent,
    empty,
    markerIndent: ind.cols,
    markerWidth: j - ind.idx,
  };
}

// Can this line start a block that interrupts a paragraph?
function interruptsParagraph(line, inListItem) {
  const ind = measureIndent(line);
  if (ind.cols > 3) return false;
  if (isBlankLine(line)) return false;
  // ATX heading
  if (matchATX(line)) return true;
  // fenced code
  if (matchFence(line)) return true;
  // thematic break (*** or ___ always; --- only when it is NOT a setext
  // underline, e.g. "--- -" is a break, "---" is a setext underline)
  if (matchThematicBreak(line)) {
    const c = line.charCodeAt(ind.idx);
    if (c !== 45) return true;
    if (matchSetext(line) === 0) return true;
  }
  // HTML block types 1-6
  const html = matchHtmlBlockStart(line);
  if (html && html.type !== 7) return true;
  // blockquote
  if (matchQuoteMarker(line)) return true;
  // list: bullet (non-empty item) or ordered starting with 1 (non-empty).
  // Inside a list item, ANY non-empty ordered marker interrupts ("* foo\n
  // 0. bar" nests a list, but "foo\n0. bar" stays a paragraph).
  const lm = matchListMarker(line);
  if (lm) {
    if (lm.bullet !== 0) {
      if (!lm.empty) return true;
    } else if ((inListItem || lm.num === 1) && !lm.empty) {
      return true;
    }
  }
  return false;
}

// ---------------- link reference definitions ----------------

// Try to parse a link reference definition starting at lines[i].
// Returns {label, dest, title, lines} or null. `lines` = lines consumed.
function tryParseLinkDef(lines, i, end) {
  const line = lines[i];
  const ind = measureIndent(line);
  if (ind.cols > 3) return null;
  let j = ind.idx;
  if (line.charCodeAt(j) !== 91) return null; // '['
  // label: up to 999 chars, may span lines, no unescaped [ or ]
  j++;
  let labelChars = '';
  let labelEndLine = i;
  let labelEndPos = -1;
  let li = i;
  let pos = j;
  outer: while (li < end) {
    const l = lines[li];
    while (pos < l.length) {
      const c = l.charCodeAt(pos);
      if (c === 92 && pos + 1 < l.length && l.charCodeAt(pos + 1) < 128 && ASCII_PUNCT[l.charCodeAt(pos + 1)] === 1) {
        labelChars += l.slice(pos, pos + 2);
        pos += 2;
        continue;
      }
      if (c === 91) return null; // unescaped '[' in label
      if (c === 93) {
        labelEndLine = li;
        labelEndPos = pos;
        break outer;
      }
      labelChars += l[pos];
      pos++;
    }
    // the label continues on the next line (the newline normalizes to a
    // space); a blank line ends the definition attempt
    li++;
    if (li >= end) return null;
    if (isBlankLine(lines[li])) return null;
    labelChars += '\n';
    pos = 0;
  }
  if (labelEndPos === -1) return null;
  const rawLabel = labelChars;
  if (rawLabel.length === 0 || rawLabel.length > 999) return null;
  // a label that normalizes to empty (only whitespace) is not a definition
  if (normalizeLabel(rawLabel).length === 0) return null;
  if (lines[labelEndLine].charCodeAt(labelEndPos + 1) !== 58) return null; // ':'
  pos = labelEndPos + 2;
  li = labelEndLine;
  // skip whitespace/newline to the destination
  for (;;) {
    while (pos < lines[li].length) {
      const c = lines[li].charCodeAt(pos);
      if (c === 32 || c === 9) pos++;
      else break;
    }
    if (pos < lines[li].length) break;
    li++;
    if (li >= end) return null;
    pos = 0;
    // destination must be on the same line or the next line
    if (li > labelEndLine + 1) return null;
  }
  const destLine = lines[li];
  let dest = '';
  if (destLine.charCodeAt(pos) === 60) {
    // <...> destination
    let k = pos + 1;
    let ok = false;
    while (k < destLine.length) {
      const c = destLine.charCodeAt(k);
      if (c === 62) { ok = true; break; }
      if (c === 60) break;
      if (c === 92 && k + 1 < destLine.length && destLine.charCodeAt(k + 1) < 128 && ASCII_PUNCT[destLine.charCodeAt(k + 1)] === 1) { k += 2; continue; }
      k++;
    }
    if (!ok) return null;
    dest = destLine.slice(pos + 1, k);
    pos = k + 1;
  } else {
    // bare destination: no spaces, balanced parens
    let k = pos;
    let depth = 0;
    while (k < destLine.length) {
      const c = destLine.charCodeAt(k);
      if (c === 32 || c === 9) break;
      if (c === 92 && k + 1 < destLine.length && destLine.charCodeAt(k + 1) < 128 && ASCII_PUNCT[destLine.charCodeAt(k + 1)] === 1) { k += 2; continue; }
      if (c === 40) { depth++; k++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--;
        k++;
        continue;
      }
      if (c < 32 || c === 127) break;
      k++;
    }
    if (k === pos) return null;
    dest = destLine.slice(pos, k);
    pos = k;
  }
  // skip whitespace; title may be on this line or the next
  let title = null;
  let tli = li;
  let tpos = pos;
  for (;;) {
    while (tpos < lines[tli].length) {
      const c = lines[tli].charCodeAt(tpos);
      if (c === 32 || c === 9) tpos++;
      else break;
    }
    if (tpos < lines[tli].length) break;
    // end of line: title may be on the next line
    if (tli + 1 >= end) break;
    if (tli + 1 > li + 1) break; // title at most one line after destination
    tli++;
    tpos = 0;
  }
  if (tli < end && tpos < lines[tli].length) {
    const q = lines[tli].charCodeAt(tpos);
    if (q === 39 || q === 34 || q === 40) {
      // a title on the same line as the destination must be preceded by
      // whitespace ("<bar>(baz)" is not a title, it is junk)
      if (tli === li && tpos === pos) return null;
      // title (may span lines for '...' and "...")
      let tContent = '';
      let tEndLine = tli;
      let tEndPos = -1;
      if (q === 40) {
        // (...) title: no unescaped parens, single line
        let k = tpos + 1;
        let depth = 0;
        const tl = lines[tli];
        while (k < tl.length) {
          const c = tl.charCodeAt(k);
          if (c === 40) { depth++; k++; continue; }
          if (c === 41) {
            if (depth === 0) { tEndPos = k + 1; tContent = tl.slice(tpos + 1, k); break; }
            depth--;
            k++;
            continue;
          }
          if (c === 92 && k + 1 < tl.length && tl.charCodeAt(k + 1) < 128 && ASCII_PUNCT[tl.charCodeAt(k + 1)] === 1) { k += 2; continue; }
          k++;
        }
        if (tEndPos === -1) {
          // a title on the next line that fails to close: the def simply
          // ends at the destination line
          if (tli > li) return { label: normalizeLabel(rawLabel), dest: cleanUrl(dest), title: null, lines: li - i + 1 };
          return null;
        }
      } else {
        // '...' or "...": may span multiple lines, but not a blank line
        let k = tpos + 1;
        let kl = tli;
        let found = false;
        while (kl < end && !found) {
          const tl = lines[kl];
          while (k < tl.length) {
            const c = tl.charCodeAt(k);
            if (c === q) { tEndLine = kl; tEndPos = k + 1; found = true; break; }
            if (c === 92 && k + 1 < tl.length && tl.charCodeAt(k + 1) < 128 && ASCII_PUNCT[tl.charCodeAt(k + 1)] === 1) { k += 2; continue; }
            k++;
          }
          if (!found) {
            kl++;
            k = 0;
            if (kl < end && isBlankLine(lines[kl])) return null;
            if (kl - tli > 20) return null; // sanity cap
          }
        }
        if (!found) {
          if (tli > li) return { label: normalizeLabel(rawLabel), dest: cleanUrl(dest), title: null, lines: li - i + 1 };
          return null;
        }
        if (tEndLine === tli) tContent = lines[tli].slice(tpos + 1, tEndPos - 1);
        else {
          const parts = [lines[tli].slice(tpos + 1)];
          for (let m = tli + 1; m < tEndLine; m++) parts.push(lines[m]);
          parts.push(lines[tEndLine].slice(0, tEndPos - 1));
          tContent = parts.join('\n');
        }
      }
      title = tContent;
      // after the title: only whitespace to end of line
      let epos = tEndPos;
      const el = lines[tEndLine];
      while (epos < el.length) {
        const c = el.charCodeAt(epos);
        if (c === 32 || c === 9) epos++;
        else {
          // junk after a next-line title: the def ends at the destination
          if (tli > li) return { label: normalizeLabel(rawLabel), dest: cleanUrl(dest), title: null, lines: li - i + 1 };
          return null;
        }
      }
      return {
        label: normalizeLabel(rawLabel),
        dest: cleanUrl(dest),
        title: cleanTitle(title),
        lines: tEndLine - i + 1,
      };
    }
    // junk after the destination on the SAME line -> not a definition.
    // But if the title search moved to the next line and it is not a
    // title, the def simply ends at the destination line (the next line
    // is separate content, e.g. another definition).
    if (tli > li) {
      return {
        label: normalizeLabel(rawLabel),
        dest: cleanUrl(dest),
        title: null,
        lines: li - i + 1,
      };
    }
    return null;
  }
  // no title: the destination line must end here (only whitespace after)
  return {
    label: normalizeLabel(rawLabel),
    dest: cleanUrl(dest),
    title: null,
    lines: li - i + 1,
  };
}

// ---------------- tables ----------------

// Split a table row into cells (unescaped | splits; leading/trailing | dropped).
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const N = line.length;
  // skip leading whitespace and an optional leading |
  while (i < N && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (line.charCodeAt(i) === 124) i++;
  while (i < N) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < N && line.charCodeAt(i + 1) === 124) {
      // "\|" is an escaped pipe: the backslash is consumed by the table,
      // the cell sees just "|" (so "`\|`" renders as <code>|</code>)
      cur += '|';
      i += 2;
      continue;
    }
    if (c === 124) {
      cells.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += line[i];
    i++;
  }
  // trailing cell: only if there is content or a trailing | was present
  const trimmed = cur.trim();
  // determine whether the line ends with an (unescaped) |
  let j = N - 1;
  while (j >= 0 && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j--;
  const endsWithPipe = j >= 0 && line.charCodeAt(j) === 124 &&
    !(j > 0 && line.charCodeAt(j - 1) === 92);
  if (!endsWithPipe) cells.push(trimmed);
  else if (trimmed !== '') cells.push(trimmed);
  return cells;
}

// Parse a delimiter row. Returns array of alignments ('left'|'right'|'center'|null) or null.
function parseDelimiterRow(line) {
  if (measureIndent(line).cols > 3) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    const left = t.charCodeAt(0) === 58;
    const right = t.charCodeAt(t.length - 1) === 58;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// ---------------- main block parser ----------------

// Does this line start any block (used after link ref defs)?
function startsAnyBlock(line) {
  if (isBlankLine(line)) return false;
  const ind = measureIndent(line);
  if (ind.cols >= 4) return true; // indented code
  if (matchFence(line) || matchATX(line) || matchThematicBreak(line)) return true;
  if (matchHtmlBlockStart(line)) return true;
  if (matchQuoteMarker(line)) return true;
  if (matchListMarker(line)) return true;
  return false;
}

function parseBlocks(lines, start, end, refs, lazy, spaceLines, inListItem) {
  const blocks = [];
  let i = start;
  // a block preceded by a blank line (and not the first block) is marked
  // afterBlank: list looseness is decided by blank lines between an item's
  // DIRECT child blocks, not by blanks inside nested structures.
  let blankBefore = false;
  function pushBlock(b) {
    if (blankBefore && blocks.length > 0) b.afterBlank = true;
    blocks.push(b);
    blankBefore = false;
  }
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { blankBefore = true; i++; continue; }

    // fenced code
    const fence = matchFence(line);
    if (fence) {
      const content = [];
      let j = i + 1;
      while (j < end) {
        const l = lines[j];
        const ind = measureIndent(l);
        if (ind.cols <= 3) {
          let k = ind.idx;
          let run = 0;
          while (k < l.length && l.charCodeAt(k) === fence.ch) { k++; run++; }
          if (run >= fence.len) {
            let m = k;
            while (m < l.length && (l.charCodeAt(m) === 32 || l.charCodeAt(m) === 9)) m++;
            if (m >= l.length) { j++; break; }
          }
        }
        // marked quirk: the fence's indent is stripped from content lines
        // only for BACKTICK fences ("   ```ts\n   foo" -> "foo"); TILDE
        // fences keep the indent ("   ~~~ts\n   foo" -> "   foo")
        if (fence.ch === 96) content.push(stripIndentStr(l, fence.indent, true));
        else content.push(l);
        j++;
      }
      // exactly one trailing EMPTY line is dropped (a line of only spaces
      // is content: "```\n\n  \n```" -> "\n  \n")
      if (content.length > 0 && content[content.length - 1] === '') content.pop();
      let text = content.length > 0 ? content.join('\n') + '\n' : '';
      const lang = fence.info === '' ? null : unescapeBackslashes(fence.info.split(/\s+/)[0]);
      pushBlock({ t: 'code', lang, text });
      i = j;
      continue;
    }

    // ATX heading
    const atx = matchATX(line);
    if (atx) {
      pushBlock({ t: 'heading', level: atx.level, text: atx.text });
      i++;
      continue;
    }

    // thematic break
    if (matchThematicBreak(line)) {
      pushBlock({ t: 'hr' });
      i++;
      continue;
    }

    // HTML block
    const html = matchHtmlBlockStart(line);
    if (html) {
      const content = [line];
      let j = i + 1;
      if (html.type >= 1 && html.type <= 5) {
        if (line.toLowerCase().indexOf(html.end) === -1) {
          while (j < end) {
            content.push(lines[j]);
            if (lines[j].toLowerCase().indexOf(html.end) !== -1) { j++; break; }
            j++;
          }
        }
      } else {
        while (j < end && !isBlankLine(lines[j])) {
          content.push(lines[j]);
          j++;
        }
      }
      // trailing newline: for types 1-5, a whitespace-only line ("\t")
      // after the block still gets the newline — only a truly EMPTY line
      // suppresses it. For types 6-7 (which end AT a blank line), any
      // blank line — empty or whitespace-only — suppresses it.
      const nextBlank = j < end && isBlankLine(lines[j]);
      const nextEmpty = j < end && lines[j].length === 0;
      const trailingNL = html.type <= 5 ? (j < end && !nextEmpty) : (j < end && !nextBlank);
      pushBlock({ t: 'html', text: content.join('\n'), trailingNL });
      i = j;
      continue;
    }

    // blockquote
    if (matchQuoteMarker(line)) {
      const res = parseQuote(lines, i, end, refs, inListItem);
      pushBlock(res.node);
      i = res.next;
      continue;
    }

    // list
    if (matchListMarker(line)) {
      const res = parseList(lines, i, end, refs, inListItem);
      pushBlock(res.node);
      i = res.next;
      continue;
    }

    // indented code
    const ind = measureIndent(line);
    if (ind.cols >= 4) {
      const content = [];
      let j = i;
      while (j < end) {
        const l = lines[j];
        if (isBlankLine(l)) {
          let k = j + 1;
          while (k < end && isBlankLine(lines[k])) k++;
          if (k < end && measureIndent(lines[k]).cols >= 4) {
            // an interior blank line keeps its content minus 4 indent
            // columns ("      " -> "  " in the code block)
            while (j < k) { content.push(stripIndentStr(lines[j], 4, true)); j++; }
            continue;
          }
          break;
        }
        if (measureIndent(l).cols < 4) break;
        content.push(stripIndentStr(l, 4, true));
        j++;
      }
      let text = content.join('\n');
      if (text.length > 0) text += '\n';
      pushBlock({ t: 'code', lang: null, text });
      i = j;
      continue;
    }

    // paragraph (link ref defs, setext, table)
    const res = parseParagraph(lines, i, end, refs, lazy, spaceLines, inListItem);
    if (res.node) pushBlock(res.node);
    i = res.next;
  }
  return blocks;
}

// Setext heading text: the first line loses its block indent (up to 3
// columns) and the whole text loses trailing spaces/tabs. (Paragraphs keep
// both; headings do not.)
function setextText(lines) {
  const first = lines[0];
  const ind = measureIndent(first);
  const head = ind.cols <= 3 ? first.slice(ind.idx) : first;
  let text = lines.length === 1 ? head : head + '\n' + lines.slice(1).join('\n');
  let e = text.length;
  while (e > 0 && (text.charCodeAt(e - 1) === 32 || text.charCodeAt(e - 1) === 9)) e--;
  return e < text.length ? text.slice(0, e) : text;
}

function parseParagraph(lines, i, end, refs, lazy, spaceLines, inListItem) {
  // link reference definitions at the start of the paragraph
  let j = i;
  while (j < end) {
    const def = tryParseLinkDef(lines, j, end);
    if (!def) break;
    if (!refs.has(def.label)) refs.set(def.label, { href: def.dest, title: def.title });
    j += def.lines;
    // a paragraph of only link ref defs still counts as a block (it renders
    // nothing, but a blank line before it loosens a list)
    if (j >= end || isBlankLine(lines[j])) return { node: { t: 'def' }, next: j };
    if (startsAnyBlock(lines[j])) return { node: { t: 'def' }, next: j };
  }
  if (j >= end || isBlankLine(lines[j])) return { node: j > i ? { t: 'def' } : null, next: j };

  // gather paragraph lines (verbatim; leading spaces are content, e.g.
  // "   foo" keeps its spaces)
  const paraLines = [];
  paraLines.push(lines[j]);
  let k = j + 1;
  while (k < end) {
    const l = lines[k];
    // a spaces-only line from a blockquote marker (">  ") is paragraph
    // content, not a blank line
    if (isBlankLine(l) && !(spaceLines && spaceLines.has(k))) break;
    // a lazy continuation line is paragraph content even if, after the
    // container stripped its indent, it looks like a block start
    // ("> foo\n    - bar" -> the "- bar" stays in the paragraph)
    if (interruptsParagraph(l, inListItem) && !(lazy && lazy.has(k))) break;
    paraLines.push(l);
    k++;
  }

  // setext heading: line 1 is an underline (beats a table delimiter);
  // else a table if line 1 is a delimiter row; else a setext underline
  // deeper in the paragraph. A lazy continuation line can never be a
  // setext underline.
  const isLazy = (idx) => lazy !== undefined && lazy !== null && lazy.has(idx);
  if (paraLines.length >= 2) {
    const lvl1 = isLazy(j + 1) ? 0 : matchSetext(paraLines[1]);
    if (lvl1 !== 0) {
      return { node: { t: 'heading', level: lvl1, text: setextText(paraLines.slice(0, 1)) }, next: j + 2 };
    }
    const aligns = parseDelimiterRow(paraLines[1]);
    if (aligns !== null) {
      const header = splitTableRow(paraLines[0]);
      if (header.length === aligns.length) {
        const rows = [];
        for (let r = 2; r < paraLines.length; r++) {
          const cells = splitTableRow(paraLines[r]);
          while (cells.length < aligns.length) cells.push('');
          rows.push(cells.slice(0, aligns.length));
        }
        // a line containing only a TAB (e.g. "\t") after the last row is an
        // empty table row, not the end of the table — but a spaces-only
        // line ends it. Keep gathering rows until a truly empty line, a
        // spaces-only line, or a block start.
        let kk = k;
        while (kk < end) {
          const l = lines[kk];
          if (l.length === 0) break;
          if (isBlankLine(l)) {
            if (l.indexOf('\t') === -1) break;
            const cells = splitTableRow(l);
            while (cells.length < aligns.length) cells.push('');
            rows.push(cells.slice(0, aligns.length));
            kk++;
            continue;
          }
          if (interruptsParagraph(l, inListItem) && !(lazy && lazy.has(kk))) break;
          const cells = splitTableRow(l);
          while (cells.length < aligns.length) cells.push('');
          rows.push(cells.slice(0, aligns.length));
          kk++;
        }
        return { node: { t: 'table', header, aligns, rows }, next: kk };
      }
    }
    for (let s = 2; s < paraLines.length; s++) {
      if (isLazy(j + s)) continue;
      const lvl = matchSetext(paraLines[s]);
      if (lvl !== 0) {
        return { node: { t: 'heading', level: lvl, text: setextText(paraLines.slice(0, s)) }, next: j + s + 1 };
      }
    }
  }

  return { node: { t: 'para', lines: paraLines }, next: k };
}

function parseQuote(lines, i, end, refs, inListItem) {
  const content = [];
  const lazy = new Set(); // indices into content[] that are lazy continuations
  const spaceLines = new Set(); // indices of spaces-only content lines from
  // marker lines (">  "): they are paragraph content, not blank lines
  let lazyRun = 0; // consecutive lazy lines (marked quirk: see below)
  let fence = null; // {ch, len} while inside a fenced code block
  // Is the last block in the content (so far) a paragraph? Strip leading
  // blockquote markers from the last non-blank content line (nested quotes
  // delegate laziness to the innermost paragraph) and check it is not a
  // block start. Lazy lines may only continue a paragraph, never code.
  function lastLineIsParagraph() {
    if (fence) return false;
    let idx = content.length - 1;
    while (idx >= 0 && isBlankLine(content[idx])) idx--;
    if (idx < 0) return false;
    let line = content[idx];
    // strip leading container markers (quotes and list items) to reach the
    // innermost content: laziness delegates to the innermost paragraph
    while (true) {
      const qm = matchQuoteMarker(line);
      if (qm) {
        line = qm.content;
        continue;
      }
      const lm = matchListMarker(line);
      if (lm && !lm.empty) {
        line = (lm.contentPrefix || '') + line.slice(lm.contentStart);
        continue;
      }
      break;
    }
    if (isBlankLine(line)) return false;
    return !startsAnyBlock(line);
  }
  function noteFence(cline) {
    if (fence) {
      const ind = measureIndent(cline);
      if (ind.cols <= 3) {
        let k = ind.idx, run = 0;
        while (k < cline.length && cline.charCodeAt(k) === fence.ch) { k++; run++; }
        if (run >= fence.len) {
          let m = k;
          while (m < cline.length && (cline.charCodeAt(m) === 32 || cline.charCodeAt(m) === 9)) m++;
          if (m >= cline.length) { fence = null; return; }
        }
      }
      return;
    }
    const f = matchFence(cline);
    if (f) fence = { ch: f.ch, len: f.len };
  }
  let j = i;
  while (j < end) {
    const line = lines[j];
    const qm = matchQuoteMarker(line);
    if (qm) {
      lazyRun = 0;
      const cline = qm.content;
      if (cline !== '' && cline.trim() === '') spaceLines.add(content.length);
      content.push(cline);
      noteFence(cline);
      j++;
      continue;
    }
    if (isBlankLine(line)) break;
    // lazy continuation: the last block must be a paragraph, the previous
    // content line non-blank, and the line must not interrupt. A '-' setext
    // underline is NOT lazy: it cannot be a setext underline when lazy, so
    // it is a thematic break and interrupts.
    if (lastLineIsParagraph() && content.length > 0 && !isBlankLine(content[content.length - 1]) &&
        !interruptsParagraph(line) && matchSetext(line) !== 2) {
      lazy.add(content.length);
      lazyRun++;
      // a lazy line with 4+ leading columns loses exactly 4 (5 spaces -> 1,
      // a tab -> 0); fewer columns are preserved verbatim.
      let pushLine = line;
      const ind = measureIndent(line);
      if (ind.cols >= 4) pushLine = stripIndentStr(line, 4);
      // marked quirk: a lazy '=' setext underline that is the 2nd or later
      // consecutive lazy line is rendered with 4 spaces prepended
      // ("> foo\nbar\n===" -> "    ==="; a lone lazy "===" gets none).
      if (lazyRun >= 2 && matchSetext(pushLine) === 1) pushLine = '    ' + pushLine;
      content.push(pushLine);
      // a lazy line is a paragraph continuation by definition: the block
      // state (fence) does not change.
      j++;
      continue;
    }
    break;
  }
  const children = parseBlocks(content, 0, content.length, refs, lazy, spaceLines, inListItem);
  return { node: { t: 'quote', ch: children }, next: j };
}

function parseList(lines, i, end, refs, inListItem) {
  const first = matchListMarker(lines[i]);
  const ordered = first.num !== -1;
  const delim = ordered ? first.delim : first.bullet;
  const start = ordered ? first.num : 0;
  const items = [];
  const metas = [];
  let j = i;
  while (j < end) {
    // blank lines between items: skip them to find the next item, but if
    // no more items follow, rewind so the enclosing parser sees the blanks
    let blankStart = -1;
    while (j < end && isBlankLine(lines[j])) {
      if (blankStart === -1) blankStart = j;
      j++;
    }
    if (j >= end) {
      if (blankStart !== -1) j = blankStart;
      break;
    }
    const line = lines[j];
    // a thematic break ends the list ("* Foo\n* * *\n* Bar": the middle
    // line is an <hr>, not a list item)
    if (matchThematicBreak(line)) {
      if (blankStart !== -1) j = blankStart;
      break;
    }
    const m = matchListMarker(line);
    if (!m) {
      if (blankStart !== -1) j = blankStart;
      break;
    }
    if (ordered) {
      if (m.num === -1 || m.delim !== delim) {
        if (blankStart !== -1) j = blankStart;
        break;
      }
    } else {
      if (m.bullet !== delim) {
        if (blankStart !== -1) j = blankStart;
        break;
      }
    }
    const res = gatherListItem(lines, j, end, m, ordered, delim, refs);
    items.push(res.item);
    metas.push(res);
    j = res.next;
  }
  // tight/loose: loose if any item has a blank line between its DIRECT child
  // blocks (a blank inside a nested list does not loosen the outer list),
  // or any item except the last ends with blank lines (separating items)
  let tight = true;
  for (let x = 0; x < metas.length; x++) {
    const ch = items[x].ch;
    for (let c = 1; c < ch.length; c++) {
      if (ch[c].afterBlank) { tight = false; break; }
    }
    if (!tight) break;
    if (x < metas.length - 1 && metas[x].hasTrailingBlank) { tight = false; break; }
  }
  return { node: { t: 'list', ordered, start, tight, items }, next: j };
}

function gatherListItem(lines, j, end, m, ordered, delim, refs) {
  const contentIndent = m.contentIndent;
  const contentLines = [];
  let lazy = new Set(); // indices into contentLines[] that are lazy continuations
  let seenContent = false;
  if (!m.empty) {
    contentLines.push((m.contentPrefix || '') + lines[j].slice(m.contentStart));
    seenContent = true;
  } else {
    contentLines.push('');
  }
  let pendingBlanks = 0;
  let hasInternalBlank = false;
  let hasTrailingBlank = false;
  let k = j + 1;
  while (k < end) {
    const l = lines[k];
    if (isBlankLine(l)) {
      pendingBlanks++;
      k++;
      continue;
    }
    const ind = measureIndent(l);
    // a list marker at a lower indent ends this item (a new item of the
    // same list, or a different list entirely: "1. foo\n2. bar\n3) baz")
    if (ind.cols < contentIndent && matchListMarker(l)) break;
    if (ind.cols >= contentIndent) {
      // an empty item followed by a blank line is empty: the following
      // content is not part of it ("-\n\n  foo" -> empty item + paragraph)
      if (!seenContent && pendingBlanks >= 1) break;
      if (pendingBlanks > 0 && seenContent) hasInternalBlank = true;
      for (let b = 0; b < pendingBlanks; b++) contentLines.push('');
      pendingBlanks = 0;
      contentLines.push(stripIndentStr(l, contentIndent));
      seenContent = true;
      k++;
      continue;
    }
    // lazy continuation (paragraph): no blank before, doesn't interrupt,
    // and the last content line must be a paragraph line (not a block
    // start — a fence, heading, or thematic break cannot be lazily
    // continued: "1. foo\n\n   ```toml\nbar" ends the item at "bar").
    // Container markers are stripped first: "> Blockquote" is a paragraph
    // inside a quote, so it CAN be lazily continued. A '-' setext
    // underline is NOT lazy (it is a thematic break when lazy). A lazy
    // line with 4+ leading columns loses exactly 4, like in quotes.
    let lastIsPara = false;
    if (contentLines.length > 0) {
      let idx = contentLines.length - 1;
      while (idx >= 0 && isBlankLine(contentLines[idx])) idx--;
      if (idx >= 0) {
        let line = contentLines[idx];
        while (true) {
          const qm = matchQuoteMarker(line);
          if (qm) { line = qm.content; continue; }
          const lm = matchListMarker(line);
          if (lm && !lm.empty) { line = (lm.contentPrefix || '') + line.slice(lm.contentStart); continue; }
          break;
        }
        lastIsPara = !isBlankLine(line) && !startsAnyBlock(line);
      }
    }
    if (pendingBlanks === 0 && contentLines.length > 0 && lastIsPara &&
        !interruptsParagraph(l) && matchSetext(l) !== 2) {
      lazy.add(contentLines.length);
      let pushLine = l;
      if (ind.cols >= 4) pushLine = stripIndentStr(l, 4);
      contentLines.push(pushLine);
      seenContent = true;
      k++;
      continue;
    }
    break;
  }
  hasTrailingBlank = pendingBlanks > 0;
  // trailing blank lines are NOT consumed: rewind so the enclosing
  // parseBlocks sees them (a blank between an item's blocks must set
  // afterBlank on the following block, loosening the list)
  const next = k - pendingBlanks;
  // drop the leading empty line for empty items (it was a placeholder)
  if (m.empty && contentLines.length > 0 && contentLines[0] === '') {
    contentLines.shift();
    const adjusted = new Set();
    for (const idx of lazy) adjusted.add(idx - 1);
    lazy = adjusted;
  }
  const children = parseBlocks(contentLines, 0, contentLines.length, refs, lazy, undefined, true);
  // task list: first block is a paragraph starting with [ ] / [x] / [X]
  let task = null;
  if (children.length > 0 && children[0].t === 'para' && children[0].lines.length > 0) {
    const firstLine = children[0].lines[0];
    if (firstLine.length >= 3 && firstLine.charCodeAt(0) === 91 && firstLine.charCodeAt(2) === 93) {
      const c = firstLine.charCodeAt(1);
      if (c === 32 || c === 120 || c === 88) {
        const after = firstLine.charCodeAt(3);
        if (firstLine.length === 3 || after === 32 || after === 9) {
          task = c !== 32;
          const rest = firstLine.slice(firstLine.length === 3 ? 3 : 4);
          children[0].lines[0] = rest;
          if (rest === '' && children[0].lines.length > 1) children[0].lines.shift();
        }
      }
    }
  }
  return { item: { ch: children, task }, next, hasInternalBlank, hasTrailingBlank };
}

// ---------------- rendering ----------------

function renderBlocks(blocks, refs, out) {
  for (const b of blocks) renderBlock(b, refs, out);
}

function renderBlock(b, refs, out) {
  switch (b.t) {
    case 'def':
      break; // link ref defs render nothing
    case 'para':
      out.push('<p>', parseInline(b.lines.join('\n'), refs), '</p>\n');
      break;
    case 'heading':
      out.push('<h', String(b.level), '>', parseInline(b.text, refs), '</h', String(b.level), '>\n');
      break;
    case 'code': {
      out.push('<pre><code');
      if (b.lang !== null) out.push(' class="language-', escapeAttr(b.lang), '"');
      out.push('>', escapeHtml(b.text), '</code></pre>\n');
      break;
    }
    case 'html':
      out.push(b.text);
      if (b.trailingNL) out.push('\n');
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'quote':
      out.push('<blockquote>\n');
      renderBlocks(b.ch, refs, out);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      if (b.ordered) {
        out.push('<ol');
        if (b.start !== 1) out.push(' start="', String(b.start), '"');
        out.push('>\n');
      } else {
        out.push('<ul>\n');
      }
      for (const item of b.items) {
        out.push('<li>');
        renderListItem(item, b.tight, refs, out);
        out.push('</li>\n');
      }
      out.push(b.ordered ? '</ol>\n' : '</ul>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let c = 0; c < b.header.length; c++) {
        out.push('<th');
        const a = b.aligns[c];
        if (a) out.push(' align="', a, '"');
        out.push('>', parseInline(b.header[c], refs), '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (b.rows.length > 0) {
        out.push('<tbody>');
        for (let r = 0; r < b.rows.length; r++) {
          out.push('<tr>\n');
          for (let c = 0; c < b.header.length; c++) {
            out.push('<td');
            const a = b.aligns[c];
            if (a) out.push(' align="', a, '"');
            out.push('>', parseInline(b.rows[r][c], refs), '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
  }
}

function renderListItem(item, tight, refs, out) {
  const ch = item.ch;
  if (ch.length === 0) return;
  // task checkbox (only when the first block is a paragraph)
  let first = 0;
  if (item.task !== null && ch[0].t === 'para') {
    if (tight) {
      out.push(item.task
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ');
      out.push(parseInline(ch[0].lines.join('\n'), refs));
      first = 1;
    } else {
      out.push('<p>');
      out.push(item.task
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ');
      out.push(parseInline(ch[0].lines.join('\n'), refs), '</p>\n');
      first = 1;
    }
  }
  for (let k = first; k < ch.length; k++) {
    const b = ch[k];
    if (tight && b.t === 'para') {
      // a paragraph in a tight item renders inline (no <p> tags, no trailing
      // newline); every other block type keeps its trailing newline
      out.push(parseInline(b.lines.join('\n'), refs));
    } else {
      renderBlock(b, refs, out);
    }
  }
}

// ---------------- entry point ----------------

export function parse(src) {
  const lines = splitLines(src);
  const refs = new Map();
  const blocks = parseBlocks(lines, 0, lines.length, refs);
  const out = [];
  renderBlocks(blocks, refs, out);
  let s = out.join('');
  // a document ending in an HTML block ends with "\n" iff the input did
  if (s !== '' && !s.endsWith('\n') && src.endsWith('\n')) s += '\n';
  return s;
}
