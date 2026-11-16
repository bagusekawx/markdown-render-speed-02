// parse.js — CommonMark 0.31.2 + GFM renderer, dependency-free, matching
// marked 18.1.3's default output byte for byte. Written from the CommonMark
// spec and the competition's practice data. Single-pass block parser over
// lines, delimiter-stack inline parser, no regular expressions in hot paths.

// ---------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------

// ASCII punctuation: !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
function isAsciiPunct(code) {
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  );
}

const RE_UNICODE_PUNCT = /[\p{P}\p{S}]/u;
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunct(c);
  return RE_UNICODE_PUNCT.test(ch);
}

// Unicode whitespace: space, tab, LF, FF, CR, VT and the Zs class.
function isSpaceCh(ch) {
  const c = ch.charCodeAt(0);
  if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) return true;
  if (c < 128) return false;
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

function isSpaceCode(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12;
}

// ---------------------------------------------------------------------------
// HTML escaping. marked escapes & < > " ' everywhere in text and code.
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  let out = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (out === null) out = s.slice(0, i);
    else out += s.slice(start, i);
    out += rep;
    start = i + 1;
  }
  if (out === null) return s;
  return out + s.slice(start);
}

// ---------------------------------------------------------------------------
// Entities. marked does NOT decode named entities: &name; passes through
// verbatim (valid or not). Numeric entities are decoded to the character,
// which is then escaped if it is one of & < > ". An & that is not part of a
// name-like &name; or a valid numeric reference is escaped to &amp;.
// parseEntityAt(text, i) with text[i] === '&' returns [html, length]
// (length includes the '&' and the ';'), or null when no reference matches.
// ---------------------------------------------------------------------------

function parseEntityAt(text, i) {
  const n = text.length;
  if (i + 1 >= n) return null;
  const c1 = text.charCodeAt(i + 1);
  if (c1 === 35) {
    // &#...; numeric reference
    let j = i + 2;
    let hex = false;
    if (j < n && (text.charCodeAt(j) === 120 || text.charCodeAt(j) === 88)) {
      hex = true;
      j++;
    }
    const d0 = j;
    let cp = 0;
    if (hex) {
      while (j < n) {
        const c = text.charCodeAt(j);
        let d = -1;
        if (c >= 48 && c <= 57) d = c - 48;
        else if (c >= 97 && c <= 102) d = c - 87;
        else if (c >= 65 && c <= 70) d = c - 55;
        else break;
        cp = cp * 16 + d;
        if (cp > 0x10ffff) return null;
        j++;
      }
    } else {
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c < 48 || c > 57) break;
        cp = cp * 10 + (c - 48);
        if (cp > 0x10ffff) return null;
        j++;
      }
    }
    if (j === d0 || j >= n || text.charCodeAt(j) !== 59) return null;
    if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return [escapeHtml(String.fromCodePoint(cp)), j + 1 - i];
  }
  // &name; — name-like references pass through verbatim.
  if (
    (c1 >= 65 && c1 <= 90) ||
    (c1 >= 97 && c1 <= 122)
  ) {
    let j = i + 2;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (
        (c >= 48 && c <= 57) ||
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122)
      ) {
        j++;
        continue;
      }
      break;
    }
    if (j < n && text.charCodeAt(j) === 59) {
      return [text.slice(i, j + 1), j + 1 - i];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Link labels: collapse internal whitespace to single spaces, case-fold.
// ---------------------------------------------------------------------------

function normalizeLabel(raw) {
  let out = '';
  let pendingSpace = false;
  let started = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (isSpaceCh(ch)) {
      if (started) pendingSpace = true;
    } else {
      if (pendingSpace) {
        out += ' ';
        pendingSpace = false;
      }
      // Full Unicode case folding: ß and ẞ fold to "ss"
      // (toLowerCase alone gives ß, which would not match SS).
      if (ch === 'ß' || ch === 'ẞ') out += 'ss';
      else out += ch;
      started = true;
    }
  }
  return out.toLowerCase();
}

// ---------------------------------------------------------------------------
// Link destination and title parsing (shared by inline links and reference
// definitions). Works on a string with an explicit position; returns
// { dest, title, end } where end is the index just past the title (or the
// destination when there is no title), or null when nothing parses.
// skipWs: skips spaces, tabs and newlines. dest may be <...> or bare.
// ---------------------------------------------------------------------------

function skipWs(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Parse a link destination starting at i (no leading whitespace allowed).
// Returns { dest, end } with dest the RAW destination (escapes kept), or null.
function parseDest(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s.charCodeAt(i) === 60) {
    // <...> form: no <, newline, or unescaped > inside.
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 62) return { dest: out, end: j + 1 };
      if (c === 60 || c === 10) return null;
      if (c === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
        out += s[j + 1];
        j += 2;
        continue;
      }
      out += s[j];
      j++;
    }
    return null;
  }
  // Bare form: non-space characters, balanced parens, no control chars.
  let j = i;
  let out = '';
  let depth = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 0) break;
    if (c < 32) return null;
    if (c === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
      out += s[j + 1];
      j += 2;
      continue;
    }
    if (c === 40) {
      depth++;
      out += '(';
      j++;
      continue;
    }
    if (c === 41) {
      if (depth === 0) break;
      depth--;
      out += ')';
      j++;
      continue;
    }
    out += s[j];
    j++;
  }
  if (depth !== 0) return null;
  return { dest: out, end: j };
}

// Parse a link title starting at i (no leading whitespace allowed).
// Returns { title, end } with title the RAW title (escapes kept), or null.
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s.charCodeAt(i);
  if (q !== 34 && q !== 39 && q !== 40) return null;
  const close = q === 40 ? 41 : q;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === close) return { title: out, end: j + 1 };
    if (q === 40 && c === 40) return null;
    if (c === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
      out += s[j + 1];
      j += 2;
      continue;
    }
    out += s[j];
    j++;
  }
  return null;
}

// Clean a raw destination or title for HTML output: entities are processed
// (numeric decoded, name-like left verbatim) and & < > " escaped.
function cleanAttr(s) {
  let out = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const ent = parseEntityAt(s, i);
      if (ent) {
        if (out === null) out = s.slice(0, i);
        else out += s.slice(start, i);
        out += ent[0];
        i += ent[1] - 1;
        start = i + 1;
        continue;
      }
      if (out === null) out = s.slice(0, i);
      else out += s.slice(start, i);
      out += '&amp;';
      start = i + 1;
    } else if (c === 60 || c === 62 || c === 34 || c === 39) {
      if (out === null) out = s.slice(0, i);
      else out += s.slice(start, i);
      out +=
        c === 60
          ? '&lt;'
          : c === 62
            ? '&gt;'
            : c === 34
              ? '&quot;'
              : '&#39;';
      start = i + 1;
    }
  }
  if (out === null) return s;
  return out + s.slice(start);
}

// Clean a raw link destination for the href/src attribute: entities are
// processed (numeric decoded then percent-encoded, name-like left verbatim),
// the rest is percent-encoded like encodeURI, and a bare & becomes &amp;.
function isHexDigit(c) {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
  );
}

// Like encodeURI, but an existing %XX sequence is left intact (marked does
// not double-encode %20 in a destination).
function encodeUrlPart(s) {
  if (s.indexOf('%') < 0) return encodeURI(s);
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (
      s.charCodeAt(i) === 37 &&
      i + 2 < s.length &&
      isHexDigit(s.charCodeAt(i + 1)) &&
      isHexDigit(s.charCodeAt(i + 2))
    ) {
      out += encodeURI(s.slice(start, i)) + s.slice(i, i + 3);
      i += 2;
      start = i + 1;
    }
  }
  out += encodeURI(s.slice(start));
  return out;
}

function cleanUrl(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 38) continue;
    const ent = parseEntityAt(s, i);
    out += encodeUrlPart(s.slice(start, i));
    if (ent) {
      if (s.charCodeAt(i + 1) === 35) {
        // numeric reference: decode, then percent-encode the character
        const ch = ent[0];
        if (ch === '&amp;') out += '&amp;';
        else if (ch === '&lt;') out += '%3C';
        else if (ch === '&gt;') out += '%3E';
        else if (ch === '&quot;') out += '%22';
        else if (ch === '&#39;') out += "'";
        else out += encodeURI(ch);
      } else {
        out += ent[0];
      }
      i += ent[1] - 1;
    } else {
      out += '&amp;';
    }
    start = i + 1;
  }
  out += encodeUrlPart(s.slice(start));
  return out;
}

// Resolve backslash escapes (\X -> X for ASCII punctuation) in a string.
function unescapeBackslashes(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s.slice(start, i) + s[i + 1];
      i++;
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

// ---------------------------------------------------------------------------
// Inline nodes. A doubly linked list per inline container; containers hold
// their children in ch/cl. Node types:
// 0 text (s = escaped HTML) · 1 code (s = literal) · 2 raw html (s)
// 3 hard break · 4 soft break · 5 em · 6 strong · 7 del · 8 link
// 9 image · 10 delimiter run · 11 GFM autolink (undoable inside a link)
// 12 explicit <...> autolink (kept inside link text)
// ---------------------------------------------------------------------------

function mkNode(t) {
  return { t, s: null, n: null, p: null, par: null, ch: null, cl: null };
}

function appendNode(list, node) {
  node.par = list;
  node.n = null;
  node.p = list.cl;
  if (list.cl) list.cl.n = node;
  else list.ch = node;
  list.cl = node;
}

function unlinkNode(node) {
  const par = node.par;
  if (node.p) node.p.n = node.n;
  else if (par) par.ch = node.n;
  if (node.n) node.n.p = node.p;
  else if (par) par.cl = node.p;
  node.n = null;
  node.p = null;
  node.par = null;
}

function insertAfterNode(node, fresh) {
  fresh.par = node.par;
  fresh.p = node;
  fresh.n = node.n;
  if (node.n) node.n.p = fresh;
  else if (node.par) node.par.cl = fresh;
  node.n = fresh;
}

// ---------------------------------------------------------------------------
// Raw HTML tags and autolinks at '<'.
// ---------------------------------------------------------------------------

// Try to read an HTML tag (open or closing) starting at src[i] === '<'.
// Returns { tag, closing, selfClose, end } or null.
function parseHtmlTag(src, i) {
  const n = src.length;
  let j = i + 1;
  let closing = false;
  if (j < n && src.charCodeAt(j) === 47) {
    closing = true;
    j++;
  }
  if (j >= n) return null;
  const c0 = src.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return null;
  j++;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 45
    ) {
      j++;
    } else break;
  }
  const tagName = src.slice(closing ? i + 2 : i + 1, j).toLowerCase();
  if (closing) {
    // A closing tag may only have whitespace before '>' (no attributes).
    let k = j;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10) k++;
      else break;
    }
    if (k < n && src.charCodeAt(k) === 62) {
      return { tag: tagName, closing: true, selfClose: false, end: k + 1 };
    }
    return null;
  }
  for (;;) {
    let k = j;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10) k++;
      else break;
    }
    if (k >= n) return null;
    const c = src.charCodeAt(k);
    if (c === 62) return { tag: tagName, closing, selfClose: false, end: k + 1 };
    if (c === 47 && k + 1 < n && src.charCodeAt(k + 1) === 62) {
      return { tag: tagName, closing, selfClose: true, end: k + 2 };
    }
    if (k === j) return null;
    j = k;
    const a0 = src.charCodeAt(j);
    if (
      !(
        (a0 >= 65 && a0 <= 90) ||
        (a0 >= 97 && a0 <= 122) ||
        a0 === 95 ||
        a0 === 58
      )
    ) {
      return null;
    }
    j++;
    while (j < n) {
      const ac = src.charCodeAt(j);
      if (
        (ac >= 48 && ac <= 57) ||
        (ac >= 65 && ac <= 90) ||
        (ac >= 97 && ac <= 122) ||
        ac === 95 ||
        ac === 58 ||
        ac === 46 ||
        ac === 45
      ) {
        j++;
      } else break;
    }
    k = j;
    while (k < n) {
      const c2 = src.charCodeAt(k);
      if (c2 === 32 || c2 === 9 || c2 === 10) k++;
      else break;
    }
    if (k < n && src.charCodeAt(k) === 61) {
      k++;
      while (k < n) {
        const c2 = src.charCodeAt(k);
        if (c2 === 32 || c2 === 9 || c2 === 10) k++;
        else break;
      }
      if (k >= n) return null;
      const vc = src.charCodeAt(k);
      if (vc === 34 || vc === 39) {
        const q = src[k];
        const end = src.indexOf(q, k + 1);
        if (end < 0) return null;
        j = end + 1;
      } else {
        let m = k;
        while (m < n) {
          const uc = src.charCodeAt(m);
          if (
            uc === 32 ||
            uc === 9 ||
            uc === 10 ||
            uc === 34 ||
            uc === 39 ||
            uc === 61 ||
            uc === 60 ||
            uc === 62 ||
            uc === 96
          ) {
            break;
          }
          m++;
        }
        if (m === k) return null;
        j = m;
      }
    } else {
      // Valueless attribute: leave j at the end of the name so the next
      // loop iteration skips the whitespace itself (j = k here would make
      // the k === j check reject the following attribute).
    }
  }
}

// Email local-part characters.
function isEmailLocalChar(c) {
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 33 ||
    c === 35 ||
    c === 36 ||
    c === 37 ||
    c === 38 ||
    c === 39 ||
    c === 42 ||
    c === 43 ||
    c === 45 ||
    c === 47 ||
    c === 61 ||
    c === 63 ||
    c === 94 ||
    c === 95 ||
    c === 96 ||
    c === 123 ||
    c === 124 ||
    c === 125 ||
    c === 126 ||
    c === 46
  );
}

// Validate an email address (no surrounding <>). Domain labels are
// alnum/hyphen, not starting or ending with a hyphen; at least one dot is
// required for the GFM form, not for the <...> form (requireDot flag).
function validEmail(s, requireDot) {
  const at = s.indexOf('@');
  if (at <= 0) return false;
  for (let i = 0; i < at; i++) {
    if (!isEmailLocalChar(s.charCodeAt(i))) return false;
  }
  let labelStart = at + 1;
  let dots = 0;
  let i = labelStart;
  const n = s.length;
  if (i >= n) return false;
  while (i <= n) {
    if (i === n || s.charCodeAt(i) === 46) {
      const len = i - labelStart;
      if (len === 0 || len > 63) return false;
      const first = s.charCodeAt(labelStart);
      const last = s.charCodeAt(i - 1);
      if (first === 45 || last === 45) return false;
      for (let k = labelStart; k < i; k++) {
        const c = s.charCodeAt(k);
        if (
          !(
            (c >= 48 && c <= 57) ||
            (c >= 65 && c <= 90) ||
            (c >= 97 && c <= 122) ||
            c === 45
          )
        ) {
          return false;
        }
      }
      if (i === n) break;
      dots++;
      labelStart = i + 1;
    }
    i++;
  }
  return requireDot ? dots >= 1 : true;
}

// Try to read an autolink <scheme:...> or <email> starting at src[i] === '<'.
// Returns { href, text, end } or null. href/text are already escaped.
function parseAutolink(src, i) {
  const end = src.indexOf('>', i + 1);
  if (end < 0) return null;
  const inner = src.slice(i + 1, end);
  if (inner.length === 0) return null;
  for (let k = 0; k < inner.length; k++) {
    const c = inner.charCodeAt(k);
    if (c <= 32 || c === 60) return null;
  }
  const colon = inner.indexOf(':');
  if (colon > 0) {
    const scheme = inner.slice(0, colon);
    if (scheme.length >= 2 && scheme.length <= 32) {
      const c0 = scheme.charCodeAt(0);
      let ok =
        (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
      for (let k = 1; ok && k < scheme.length; k++) {
        const c = scheme.charCodeAt(k);
        ok =
          (c >= 48 && c <= 57) ||
          (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) ||
          c === 43 ||
          c === 46 ||
          c === 45;
      }
      if (ok) {
        const href = cleanUrl(inner);
        return { href, text: cleanAttr(inner), end: end + 1 };
      }
    }
  }
  if (inner.indexOf('@') > 0 && validEmail(inner, false)) {
    const esc = cleanAttr(inner);
    return { href: 'mailto:' + cleanUrl(inner), text: esc, end: end + 1 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// GFM extended autolinks: www. domains, scheme:// URLs and email addresses.
// A domain is labels of alnum/hyphen (not starting/ending with a hyphen),
// at least one dot, last label all letters, length >= 2.
// Returns the end index of the domain (exclusive) starting at i, or -1.
// ---------------------------------------------------------------------------

function scanDomain(src, i) {
  const n = src.length;
  let j = i;
  let labels = 0;
  let lastLabelStart = -1;
  let lastLabelLen = 0;
  for (;;) {
    const start = j;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (
        (c >= 48 && c <= 57) ||
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        c === 45
      ) {
        j++;
      } else break;
    }
    const len = j - start;
    if (len === 0) {
      // Empty label after a dot (trailing '.'): the domain ends at the
      // previous label, if that label is a valid TLD.
      if (labels >= 2 && lastLabelLen >= 2) {
        let ok = true;
        for (let k = lastLabelStart; k < lastLabelStart + lastLabelLen; k++) {
          const c = src.charCodeAt(k);
          if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
            ok = false;
            break;
          }
        }
        if (ok) return lastLabelStart + lastLabelLen;
      }
      return -1;
    }
    if (len > 63) return -1;
    if (src.charCodeAt(start) === 45 || src.charCodeAt(j - 1) === 45) return -1;
    labels++;
    lastLabelStart = start;
    lastLabelLen = len;
    if (j < n && src.charCodeAt(j) === 46) {
      j++;
      continue;
    }
    break;
  }
  if (labels < 2) return -1;
  if (lastLabelLen < 2) return -1;
  for (let k = lastLabelStart; k < lastLabelStart + lastLabelLen; k++) {
    const c = src.charCodeAt(k);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return -1;
  }
  return j;
}

// Scan an email domain after '@': labels of alphanumerics/hyphens separated
// by dots, at least one dot. Unlike www domains, the last label may be a
// single letter (a.b is a valid email domain). A trailing dot ends the
// domain before the dot.
function scanEmailDomain(src, i) {
  const n = src.length;
  let j = i;
  let labels = 0;
  let lastEnd = -1;
  for (;;) {
    const start = j;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (
        (c >= 48 && c <= 57) ||
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        c === 45
      ) {
        j++;
      } else break;
    }
    const len = j - start;
    if (len === 0 || len > 63) {
      if (len === 0 && labels >= 2) return lastEnd;
      return -1;
    }
    if (src.charCodeAt(start) === 45 || src.charCodeAt(j - 1) === 45) return -1;
    labels++;
    lastEnd = j;
    if (j < n && src.charCodeAt(j) === 46) {
      j++;
      continue;
    }
    break;
  }
  if (labels < 2) return -1;
  return j;
}

// Scan the content after a "scheme:" (no //): an email address or a domain,
// optionally followed by one /path-segment. Returns the end index or -1.
function scanSchemeContent(src, i) {
  const n = src.length;
  let end = -1;
  // Try an email address first: local@domain.
  let j = i;
  while (j < n && isEmailLocalChar(src.charCodeAt(j))) j++;
  if (j > i && j < n && src.charCodeAt(j) === 64) {
    const domEnd = scanEmailDomain(src, j + 1);
    if (domEnd > 0) end = domEnd;
  }
  if (end < 0) {
    const domEnd = scanDomain(src, i);
    if (domEnd > 0) end = domEnd;
  }
  if (end < 0) return -1;
  // At most one /path-segment after the email/domain.
  if (end < n && src.charCodeAt(end) === 47) {
    let k = end + 1;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (
        c === 32 ||
        c === 9 ||
        c === 10 ||
        c === 60 ||
        c === 62 ||
        c === 47
      ) {
        break;
      }
      k++;
    }
    if (k > end + 1) end = k;
  }
  return end;
}

// Valid HTML entity names (for the GFM autolink ';' rule: a trailing
// &name; is kept only when name is a valid entity, otherwise the whole
// &name; is dropped from the URL).
const VALID_ENTITIES = new Set([
  'amp', 'lt', 'gt', 'quot', 'apos', 'nbsp', 'copy', 'reg', 'trade',
  'hellip', 'mdash', 'ndash', 'ouml', 'AElig', 'aelig', 'Dcaron',
  'frac34', 'frac12', 'frac14', 'HilbertSpace', 'DifferentialD',
  'ClockwiseContourIntegral', 'ngE', 'lsquo', 'rsquo', 'ldquo', 'rdquo',
  'laquo', 'raquo', 'euro', 'pound', 'yen', 'cent', 'deg', 'plusmn',
  'times', 'divide', 'eacute', 'Eacute', 'agrave', 'egrave', 'igrave',
  'ograve', 'ugrave', 'aacute', 'iacute', 'oacute', 'uacute', 'acirc',
  'ecirc', 'icirc', 'ocirc', 'ucirc', 'atilde', 'ntilde', 'otilde',
  'aring', 'ccedil', 'yuml', 'szlig', 'yacute', 'thorn', 'eth',
  'micro', 'para', 'middot', 'cedil', 'ordf', 'ordm', 'iexcl',
  'iquest', 'curren', 'brvbar', 'sect', 'uml', 'sup1', 'sup2', 'sup3',
]);

// Trim trailing punctuation from a GFM autolink URL (src[start..end)):
// trailing ? ! . , : * _ ~ ' are dropped; a trailing ) is dropped while
// parens are unbalanced; a trailing ; is dropped unless it ends an entity.
function trimGfmUrl(src, start, end) {
  let e = end;
  for (;;) {
    if (e <= start) return e;
    const c = src.charCodeAt(e - 1);
    if (
      c === 63 ||
      c === 33 ||
      c === 46 ||
      c === 44 ||
      c === 58 ||
      c === 42 ||
      c === 95 ||
      c === 126 ||
      c === 39
    ) {
      e--;
      continue;
    }
    if (c === 59) {
      // ';' — keep it when it ends a valid &name; entity; otherwise drop
      // the whole &name; (the autolink ends before the &).
      let k = e - 2;
      while (k >= start) {
        const cc = src.charCodeAt(k);
        if (
          (cc >= 48 && cc <= 57) ||
          (cc >= 65 && cc <= 90) ||
          (cc >= 97 && cc <= 122)
        ) {
          k--;
          continue;
        }
        break;
      }
      if (k >= start && src.charCodeAt(k) === 38 && k < e - 2) {
        if (VALID_ENTITIES.has(src.slice(k + 1, e - 1))) return e;
        e = k;
        continue;
      }
      e--;
      continue;
    }
    if (c === 41) {
      let open = 0;
      let close = 0;
      for (let k = start; k < e; k++) {
        const cc = src.charCodeAt(k);
        if (cc === 40) open++;
        else if (cc === 41) close++;
      }
      if (close > open) {
        e--;
        continue;
      }
      return e;
    }
    return e;
  }
}

// Scan a path after a GFM domain: any chars except whitespace, < and >.
// Returns the end index (exclusive) after trimming trailing punctuation.
function scanGfmPath(src, i) {
  const n = src.length;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62) break;
    j++;
  }
  return trimGfmUrl(src, i, j);
}

// Whether the character before position i can precede a GFM autolink:
// start of string, whitespace, or one of * _ ~ (.
function gfmBoundaryOk(src, i) {
  if (i === 0) return true;
  const c = src.charCodeAt(i - 1);
  return (
    c === 32 ||
    c === 9 ||
    c === 10 ||
    c === 42 ||
    c === 95 ||
    c === 126 ||
    c === 40 ||
    c === 60
  );
}

// ---------------------------------------------------------------------------
// Inline parsing.
// ---------------------------------------------------------------------------

function unescapeLabel(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (
      raw.charCodeAt(i) === 92 &&
      i + 1 < raw.length &&
      isAsciiPunct(raw.charCodeAt(i + 1))
    ) {
      out += raw[i + 1];
      i++;
    } else {
      out += raw[i];
    }
  }
  return out;
}

// Parse a reference label [label] starting at src[i] === '['.
// Returns { raw, end } (raw keeps backslash escapes) or null.
function parseRefLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 93) {
      const raw = src.slice(i + 1, j);
      if (raw.length > 999) return null;
      return { raw, end: j + 1 };
    }
    if (c === 91) return null;
    if (c === 92 && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) {
      j += 2;
      continue;
    }
    j++;
  }
  return null;
}

function processEmphasis(delimiters) {
  // Closers are processed in document order (first to last); for each
  // closer the nearest preceding opener of the same character is used.
  let current = delimiters.length ? delimiters[0] : null;
  while (current) {
    const currentNext = current.dnext;
    if (current.canClose) {
      let opener = current.dprev;
      while (opener) {
        const openerPrev = opener.dprev;
        if (opener.c === current.c && opener.canOpen) {
          // Odd-match rule.
          if (
            (opener.canClose || current.canOpen) &&
            (opener.len + current.len) % 3 === 0 &&
            (opener.len % 3 !== 0 || current.len % 3 !== 0)
          ) {
            opener = openerPrev;
            continue;
          }
          const use = opener.len >= 2 && current.len >= 2 ? 2 : 1;
          const tag = current.c === '~' ? 7 : use === 2 ? 6 : 5;
          const em = mkNode(tag);
          // Move the nodes between opener and closer into the new node.
          let node = opener.n;
          while (node && node !== current) {
            const nx = node.n;
            unlinkNode(node);
            appendNode(em, node);
            node = nx;
          }
          insertAfterNode(opener, em);
          opener.len -= use;
          current.len -= use;
          let openerGone = false;
          if (opener.len === 0) {
            if (opener.dprev) opener.dprev.dnext = opener.dnext;
            if (opener.dnext) opener.dnext.dprev = opener.dprev;
            unlinkNode(opener);
            openerGone = true;
          }
          if (current.len === 0) {
            if (current.dprev) current.dprev.dnext = current.dnext;
            if (current.dnext) current.dnext.dprev = current.dprev;
            unlinkNode(current);
            break;
          }
          // The same opener may match the same closer again (***foo***);
          // only advance when the opener was used up.
          if (openerGone) opener = openerPrev;
          continue;
        }
        opener = openerPrev;
      }
    }
    current = currentNext;
  }
}

function renderAlt(node, out) {
  while (node) {
    switch (node.t) {
      case 0:
        out.push(node.s);
        break;
      case 1:
        out.push(escapeHtml(node.s));
        break;
      case 5:
      case 6:
      case 7:
      case 8:
      case 9:
        renderAlt(node.ch, out);
        break;
      case 3:
      case 4:
        out.push('\n');
        break;
      case 10:
        out.push(node.c.repeat(node.len));
        break;
      case 11:
        out.push(node.s);
        break;
      case 12:
        out.push(node.s);
        break;
      default:
        break;
    }
    node = node.n;
  }
}

function renderInline(node, out) {
  while (node) {
    switch (node.t) {
      case 0:
        out.push(node.s);
        break;
      case 1:
        out.push('<code>', escapeHtml(node.s), '</code>');
        break;
      case 2:
        out.push(node.s);
        break;
      case 3:
        out.push('<br>');
        break;
      case 4:
        out.push('\n');
        break;
      case 5:
        out.push('<em>');
        renderInline(node.ch, out);
        out.push('</em>');
        break;
      case 6:
        out.push('<strong>');
        renderInline(node.ch, out);
        out.push('</strong>');
        break;
      case 7:
        out.push('<del>');
        renderInline(node.ch, out);
        out.push('</del>');
        break;
      case 8:
        out.push('<a href="', node.href, '"');
        if (node.title) out.push(' title="', node.title, '"');
        out.push('>');
        renderInline(node.ch, out);
        out.push('</a>');
        break;
      case 9:
        out.push('<img src="', node.href, '" alt="');
        renderAlt(node.ch, out);
        out.push('"');
        if (node.title) out.push(' title="', node.title, '"');
        out.push('>');
        break;
      case 10:
        out.push(node.c.repeat(node.len));
        break;
      case 11:
        out.push('<a href="', node.href, '">', node.s, '</a>');
        break;
      case 12:
        out.push('<a href="', node.href, '">', node.s, '</a>');
        break;
      default:
        break;
    }
    node = node.n;
  }
}

// Parse inline content into a node list; returns the list {ch, cl}.
// ctx: { refs: Map<label, {dest, title}>, inLink: bool } — inLink persists
// across the whole document (an unclosed raw <a> suppresses GFM autolinks).
// Whether the sibling chain starting at node (or any of its descendants)
// contains a link node (type 8). A link whose text already contains a link
// does not form.
function containsLink(node) {
  let cur = node;
  while (cur) {
    if (cur.t === 8) return true;
    if (cur.ch && containsLink(cur.ch)) return true;
    cur = cur.n;
  }
  return false;
}

function parseInline(src, ctx) {
  const list = { ch: null, cl: null };
  const delimiters = [];
  const brackets = [];
  const n = src.length;
  let i = 0;
  let textStart = 0;

  const flushText = (end) => {
    if (end > textStart) {
      const node = mkNode(0);
      node.s = escapeHtml(src.slice(textStart, end));
      node.pos = textStart;
      appendNode(list, node);
    }
    textStart = end;
  };

  while (i < n) {
    const c = src.charCodeAt(i);

    if (c === 96) {
      // Backtick run: code span or literal backticks.
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const runLen = j - i;
      let close = -1;
      let k = j;
      while (k < n) {
        const b = src.indexOf('`', k);
        if (b < 0) break;
        let e = b;
        while (e < n && src.charCodeAt(e) === 96) e++;
        if (e - b === runLen) {
          close = b;
          break;
        }
        k = e;
      }
      if (close >= 0) {
        flushText(i);
        let content = src.slice(j, close);
        if (content.indexOf('\n') >= 0) content = content.replace(/\n/g, ' ');
        if (
          content.length >= 2 &&
          content.charCodeAt(0) === 32 &&
          content.charCodeAt(content.length - 1) === 32 &&
          content.trim() !== ''
        ) {
          content = content.slice(1, -1);
        }
        const node = mkNode(1);
        node.s = content;
        appendNode(list, node);
        i = close + runLen;
        textStart = i;
      } else {
        i = j;
      }
      continue;
    }

    if (c === 42 || c === 95 || c === 126) {
      // Delimiter run: * _ ~
      flushText(i);
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const runLen = j - i;
      if (c === 126 && runLen >= 3) {
        // Runs of 3+ tildes never form strikethrough (GFM): they stay
        // literal text. (flushText already ran; the run is re-included
        // in the text at the next flush.)
        i = j;
        continue;
      }
      const before = i > 0 ? src[i - 1] : '';
      const after = j < n ? src[j] : '';
      const beforeSpace = before === '' || isSpaceCh(before);
      const afterSpace = after === '' || isSpaceCh(after);
      const beforePunct = before !== '' && isPunctCh(before);
      const afterPunct = after !== '' && isPunctCh(after);
      const leftFlank =
        !afterSpace && (!afterPunct || beforeSpace || beforePunct);
      const rightFlank =
        !beforeSpace && (!beforePunct || afterSpace || afterPunct);
      const d = mkNode(10);
      d.c = String.fromCharCode(c);
      d.len = runLen;
      d.pos = i;
      if (c === 95) {
        d.canOpen = leftFlank && (!rightFlank || beforePunct);
        d.canClose = rightFlank && (!leftFlank || afterPunct);
      } else {
        d.canOpen = leftFlank;
        d.canClose = rightFlank;
      }
      d.active = true;
      appendNode(list, d);
      d.dprev = delimiters.length ? delimiters[delimiters.length - 1] : null;
      d.dnext = null;
      if (d.dprev) d.dprev.dnext = d;
      delimiters.push(d);
      i = j;
      textStart = i;
      continue;
    }

    if (c === 91) {
      // [
      flushText(i);
      const node = mkNode(0);
      node.s = '[';
      appendNode(list, node);
      brackets.push({ node, pos: i, isImage: false, active: true });
      i++;
      textStart = i;
      continue;
    }

    if (c === 33) {
      // ![ — image opener
      if (i + 1 < n && src.charCodeAt(i + 1) === 91) {
        flushText(i);
        const node = mkNode(0);
        node.s = '![';
        appendNode(list, node);
        brackets.push({ node, pos: i + 1, isImage: true, active: true });
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    if (c === 93) {
      // ] — try to resolve a link.
      flushText(i);
      let bIdx = brackets.length - 1;
      while (bIdx >= 0 && !brackets[bIdx].active) bIdx--;
      if (bIdx < 0) {
        i++;
        continue;
      }
      const br = brackets[bIdx];
      let linkEnd = -1;
      let dest = null;
      let title = null;
      const after = i + 1;
      const nextCh = after < n ? src.charCodeAt(after) : -1;
      const shortcutRef = () => {
        const rawLabel = src.slice(br.pos + 1, i);
        const label = normalizeLabel(rawLabel);
        if (label === '') return null;
        return ctx.refs.get(label) || null;
      };
      if (nextCh === 40) {
        // Inline link ( ... ). If it fails to parse, fall back to a
        // shortcut reference.
        const k = skipWs(src, after + 1);
        const d = parseDest(src, k);
        if (d) {
          const k2 = skipWs(src, d.end);
          if (k2 < n && src.charCodeAt(k2) === 41) {
            linkEnd = k2 + 1;
            dest = d.dest;
          } else {
            const t = parseTitle(src, k2);
            if (t) {
              const k3 = skipWs(src, t.end);
              if (k3 < n && src.charCodeAt(k3) === 41) {
                linkEnd = k3 + 1;
                dest = d.dest;
                title = t.title;
              }
            }
          }
        }
        if (linkEnd < 0) {
          const ref = shortcutRef();
          if (ref) {
            linkEnd = i + 1;
            dest = ref.dest;
            title = ref.title;
          }
        }
      } else if (nextCh === 91) {
        // Full or collapsed reference [label] or []. If a complete
        // [...] follows but matches nothing, there is NO shortcut
        // fallback; if there is no complete [...], fall back.
        const lbl = parseRefLabel(src, after);
        if (lbl) {
          const rawLabel =
            lbl.raw === '' ? src.slice(br.pos + 1, i) : lbl.raw;
          const label = normalizeLabel(rawLabel);
          if (label !== '') {
            const ref = ctx.refs.get(label);
            if (ref) {
              linkEnd = lbl.end;
              dest = ref.dest;
              title = ref.title;
            }
          }
        } else {
          const ref = shortcutRef();
          if (ref) {
            linkEnd = i + 1;
            dest = ref.dest;
            title = ref.title;
          }
        }
      } else {
        const ref = shortcutRef();
        if (ref) {
          linkEnd = i + 1;
          dest = ref.dest;
          title = ref.title;
        }
      }
      if (linkEnd < 0) {
        br.active = false;
        i++;
        continue;
      }
      // A link whose text already contains a link does not form (images
      // may contain links in their alt text).
      if (!br.isImage && containsLink(br.node.n)) {
        br.active = false;
        i++;
        continue;
      }
      // Form the link or image.
      const node = mkNode(br.isImage ? 9 : 8);
      node.href = cleanUrl(dest);
      node.title = title ? cleanAttr(title) : null;
      let child = br.node.n;
      while (child) {
        const nx = child.n;
        if (child.t === 11) {
          // A GFM autolink inside link text is undone.
          child.t = 0;
        }
        unlinkNode(child);
        appendNode(node, child);
        child = nx;
      }
      insertAfterNode(br.node, node);
      unlinkNode(br.node);
      for (let k = bIdx + 1; k < brackets.length; k++) {
        brackets[k].active = false;
      }
      brackets.splice(bIdx, 1);
      i = linkEnd;
      textStart = i;
      continue;
    }

    if (c === 60) {
      // < — HTML comment / declaration / CDATA / PI / tag / autolink.
      let handled = false;
      if (i + 1 < n && src.charCodeAt(i + 1) === 33) {
        if (src.startsWith('<!-->', i) || src.startsWith('<!--->', i)) {
          // Abruptly closed comment: complete at the '>'.
          const end = src.startsWith('<!--->', i) ? i + 6 : i + 5;
          flushText(i);
          const node = mkNode(2);
          node.s = src.slice(i, end);
          appendNode(list, node);
          i = end;
          textStart = i;
          handled = true;
        } else if (src.startsWith('<!--', i)) {
          const end = src.indexOf('-->', i + 4);
          if (end >= 0) {
            flushText(i);
            const node = mkNode(2);
            node.s = src.slice(i, end + 3);
            appendNode(list, node);
            i = end + 3;
            textStart = i;
            handled = true;
          }
        } else if (src.startsWith('<![CDATA[', i)) {
          const end = src.indexOf(']]>', i + 9);
          if (end >= 0) {
            flushText(i);
            const node = mkNode(2);
            node.s = src.slice(i, end + 3);
            appendNode(list, node);
            i = end + 3;
            textStart = i;
            handled = true;
          }
        } else if (
          i + 2 < n &&
          src.charCodeAt(i + 2) >= 65 &&
          src.charCodeAt(i + 2) <= 90
        ) {
          const end = src.indexOf('>', i + 2);
          if (end >= 0) {
            flushText(i);
            const node = mkNode(2);
            node.s = src.slice(i, end + 1);
            appendNode(list, node);
            i = end + 1;
            textStart = i;
            handled = true;
          }
        }
      } else if (i + 1 < n && src.charCodeAt(i + 1) === 63) {
        const end = src.indexOf('?>', i + 2);
        if (end >= 0) {
          flushText(i);
          const node = mkNode(2);
          node.s = src.slice(i, end + 2);
          appendNode(list, node);
          i = end + 2;
          textStart = i;
          handled = true;
        }
      }
      if (!handled) {
        const tag = parseHtmlTag(src, i);
        if (tag) {
          flushText(i);
          const node = mkNode(2);
          node.s = src.slice(i, tag.end);
          appendNode(list, node);
          if (tag.tag === 'a') {
            if (tag.closing) ctx.inLink = false;
            else if (!tag.selfClose) ctx.inLink = true;
          }
          i = tag.end;
          textStart = i;
          handled = true;
        } else {
          const al = parseAutolink(src, i);
          if (al) {
            flushText(i);
            const node = mkNode(12);
            node.href = al.href;
            node.s = al.text;
            appendNode(list, node);
            i = al.end;
            textStart = i;
            handled = true;
          }
        }
      }
      if (!handled) i++;
      continue;
    }

    if (c === 38) {
      // & — entity reference or literal ampersand.
      const ent = parseEntityAt(src, i);
      flushText(i);
      const node = mkNode(0);
      if (ent) {
        node.s = ent[0];
        appendNode(list, node);
        i += ent[1];
      } else {
        node.s = '&amp;';
        appendNode(list, node);
        i++;
      }
      textStart = i;
      continue;
    }

    if (c === 92) {
      // Backslash: hard break, escaped punctuation, or literal backslash.
      if (i + 1 < n && src.charCodeAt(i + 1) === 10) {
        flushText(i);
        appendNode(list, mkNode(3));
        i += 2;
        // A hard break strips leading spaces/tabs on the next line.
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        textStart = i;
        continue;
      }
      if (i + 1 < n && isAsciiPunct(src.charCodeAt(i + 1))) {
        flushText(i);
        const node = mkNode(0);
        node.s = escapeHtml(src[i + 1]);
        appendNode(list, node);
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    if (c === 10) {
      // Newline: hard break (2+ spaces before it) or soft break.
      let sp = 0;
      let k = i - 1;
      while (k >= textStart && src.charCodeAt(k) === 32) {
        sp++;
        k--;
      }
      if (sp >= 2) {
        // Hard break: strip all trailing spaces/tabs, and the leading
        // spaces/tabs of the next line.
        let t = i - 1;
        while (t >= textStart) {
          const cc = src.charCodeAt(t);
          if (cc === 32 || cc === 9) t--;
          else break;
        }
        flushText(t + 1);
        appendNode(list, mkNode(3));
        i++;
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        textStart = i;
      } else {
        // Soft break: a single trailing space is kept (cm-649).
        flushText(i);
        appendNode(list, mkNode(4));
        i++;
        textStart = i;
      }
      continue;
    }

    if (c === 119 && !ctx.inLink && src.startsWith('www.', i)) {
      // GFM www autolink.
      if (gfmBoundaryOk(src, i)) {
        const domEnd = scanDomain(src, i + 4);
        if (domEnd > 0) {
          const end = scanGfmPath(src, domEnd);
          const text = src.slice(i, end);
          flushText(i);
          const node = mkNode(11);
          node.href = 'http://' + cleanUrl(text);
          node.s = cleanAttr(text);
          appendNode(list, node);
          i = end;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    if (c === 58 && !ctx.inLink) {
      // GFM scheme:// autolink: look back for the scheme.
      let s0 = i - 1;
      while (s0 >= 0) {
        const cc = src.charCodeAt(s0);
        if (
          (cc >= 48 && cc <= 57) ||
          (cc >= 65 && cc <= 90) ||
          (cc >= 97 && cc <= 122) ||
          cc === 43 ||
          cc === 46 ||
          cc === 45
        ) {
          s0--;
        } else break;
      }
      s0++;
      const schemeLen = i - s0;
      const schemeOk =
        schemeLen >= 2 &&
        schemeLen <= 32 &&
        s0 < i &&
        ((src.charCodeAt(s0) >= 65 && src.charCodeAt(s0) <= 90) ||
          (src.charCodeAt(s0) >= 97 && src.charCodeAt(s0) <= 122)) &&
        gfmBoundaryOk(src, s0);
      if (
        schemeOk &&
        i + 2 < n &&
        src.charCodeAt(i + 1) === 47 &&
        src.charCodeAt(i + 2) === 47
      ) {
        const domEnd = scanDomain(src, i + 3);
        if (domEnd > 0) {
          const end = scanGfmPath(src, domEnd);
          const text = src.slice(s0, end);
          flushText(s0);
          const node = mkNode(11);
          node.href = cleanUrl(text);
          node.s = cleanAttr(text);
          appendNode(list, node);
          i = end;
          textStart = i;
          continue;
        }
      } else if (schemeOk) {
        // scheme:email or scheme:domain (no //), e.g. mailto:foo@bar.baz.
        const end0 = scanSchemeContent(src, i + 1);
        // A '_' right after the content invalidates it (as for emails).
        if (end0 > 0 && !(end0 < n && src.charCodeAt(end0) === 95)) {
          const end = trimGfmUrl(src, s0, end0);
          const text = src.slice(s0, end);
          flushText(s0);
          const node = mkNode(11);
          node.href = cleanUrl(text);
          node.s = cleanAttr(text);
          appendNode(list, node);
          i = end;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    if (c === 64 && !ctx.inLink) {
      // GFM email autolink: look back for the local part.
      let s0 = i - 1;
      while (s0 >= 0 && isEmailLocalChar(src.charCodeAt(s0))) s0--;
      s0++;
      if (s0 < i && gfmBoundaryOk(src, s0)) {
        const domEnd = scanEmailDomain(src, i + 1);
        // A '_' (or other word char) right after the domain invalidates
        // the email (it would be part of a longer word).
        if (domEnd > 0 && !(domEnd < n && src.charCodeAt(domEnd) === 95)) {
          // Remove nodes already created inside the local part (e.g. a
          // '_' delimiter run): the email replaces all of [s0, domEnd).
          let tail = list.cl;
          while (tail && tail.pos !== undefined && tail.pos >= s0) {
            const prev = tail.p;
            if (tail.t === 10) {
              tail.canOpen = false;
              tail.canClose = false;
            }
            unlinkNode(tail);
            tail = prev;
          }
          const text = src.slice(s0, domEnd);
          flushText(s0);
          const node = mkNode(11);
          node.href = 'mailto:' + cleanUrl(text);
          node.s = cleanAttr(text);
          appendNode(list, node);
          i = domEnd;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    i++;
  }

  flushText(n);
  processEmphasis(delimiters);
  return list;
}

// ---------------------------------------------------------------------------
// Block parsing. Lines are scanned with a (offset, col, spaces) position:
// offset is a char index, col the visual column (tabs to next multiple of 4),
// spaces the pending virtual spaces when a tab was partly consumed.
// ---------------------------------------------------------------------------

function advCols(line, offset, col, spaces, n) {
  let o = offset;
  let c = col;
  let sp = spaces;
  let rem = n;
  if (sp > 0) {
    const take = sp < rem ? sp : rem;
    sp -= take;
    rem -= take;
  }
  while (rem > 0 && o < line.length) {
    const ch = line.charCodeAt(o);
    if (ch === 9) {
      const w = 4 - (c % 4);
      if (w <= rem) {
        o++;
        c += w;
        rem -= w;
      } else {
        sp = w - rem;
        o++;
        c += w;
        rem = 0;
      }
    } else if (ch === 32) {
      o++;
      c++;
      rem--;
    } else {
      break;
    }
  }
  return { offset: o, col: c, spaces: sp };
}

function indentFrom(line, offset, col, spaces) {
  let o = offset;
  let c = col;
  let ind = spaces;
  while (o < line.length) {
    const ch = line.charCodeAt(o);
    if (ch === 32) {
      o++;
      c++;
      ind++;
    } else if (ch === 9) {
      const w = 4 - (c % 4);
      o++;
      c += w;
      ind += w;
    } else {
      break;
    }
  }
  return { indent: ind, offset: o, col: c, spaces: 0 };
}

function contentAfter(line, offset, col, spaces, n) {
  const a = advCols(line, offset, col, spaces, n);
  return (a.spaces ? ' '.repeat(a.spaces) : '') + line.slice(a.offset);
}

function blankFrom(line, offset) {
  for (let j = offset; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function mkBlock(t, parent) {
  const b = {
    t,
    ch: [],
    parent,
    open: true,
    lines: null,
    level: 0,
    fenced: false,
    info: '',
    fenceCh: '',
    fenceLen: 0,
    fenceIndent: 0,
    htmlType: 0,
    endTag: null,
    ordered: false,
    start: 1,
    delim: '',
    bullet: '',
    tight: true,
    looseByBlank: false,
    pad: 0,
    blankAfter: false,
    blankBetween: false,
    hadChildAfterBlank: false,
    aligns: null,
    headCells: null,
    rows: null,
  };
  if (parent) {
    parent.ch.push(b);
    // A child added to an item right after a blank line (and the item
    // already had a child) means two children separated by a blank line.
    if (
      parent.t === 'item' &&
      pbLastBlank === pbLineIdx - 1 &&
      parent.ch.length > 1
    ) {
      parent.hadChildAfterBlank = true;
    }
  }
  return b;
}

function lastOpenChild(block) {
  for (let i = block.ch.length - 1; i >= 0; i--) {
    if (block.ch[i].open) return block.ch[i];
  }
  return null;
}

function isContainer(block) {
  return block.t === 'quote' || block.t === 'list' || block.t === 'item';
}

// --- Block-start matchers (all take the current line position) ---

function matchATX(line, offset, col, spaces) {
  const ind = indentFrom(line, offset, col, spaces);
  if (ind.indent > 3) return null;
  const j = ind.offset;
  if (line.charCodeAt(j) !== 35) return null;
  let k = j;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  const level = k - j;
  if (level > 6) return null;
  if (k < line.length) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  let s = k;
  while (s < line.length) {
    const c = line.charCodeAt(s);
    if (c !== 32 && c !== 9) break;
    s++;
  }
  let e = line.length;
  while (e > s) {
    const c = line.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  if (e > s && line.charCodeAt(e - 1) === 35) {
    let h = e;
    while (h > s && line.charCodeAt(h - 1) === 35) h--;
    if (h === s) {
      // The whole content is a closing sequence (preceded by the space
      // after the opening marker).
      e = s;
    } else {
      const c = line.charCodeAt(h - 1);
      if (c === 32 || c === 9) {
        e = h - 1;
        while (e > s) {
          const c2 = line.charCodeAt(e - 1);
          if (c2 !== 32 && c2 !== 9) break;
          e--;
        }
      }
    }
  }
  return { level, content: line.slice(s, e) };
}

function matchFenced(line, offset, col, spaces) {
  const ind = indentFrom(line, offset, col, spaces);
  if (ind.indent > 3) return null;
  const j = ind.offset;
  const ch = line.charCodeAt(j);
  if (ch !== 96 && ch !== 126) return null;
  let k = j;
  while (k < line.length && line.charCodeAt(k) === ch) k++;
  const len = k - j;
  if (len < 3) return null;
  let s = k;
  while (s < line.length) {
    const c = line.charCodeAt(s);
    if (c !== 32 && c !== 9) break;
    s++;
  }
  let e = line.length;
  while (e > s) {
    const c = line.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  const info = line.slice(s, e);
  if (ch === 96 && info.indexOf('`') >= 0) return null;
  return {
    fenceCh: String.fromCharCode(ch),
    fenceLen: len,
    fenceIndent: ind.indent,
    info,
  };
}

function isClosingFence(line, offset, col, spaces, fenceCh, fenceLen) {
  const ind = indentFrom(line, offset, col, spaces);
  if (ind.indent > 3) return false;
  const j = ind.offset;
  const fc = fenceCh.charCodeAt(0);
  if (line.charCodeAt(j) !== fc) return false;
  let k = j;
  while (k < line.length && line.charCodeAt(k) === fc) k++;
  if (k - j < fenceLen) return false;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
    k++;
  }
  return true;
}

function matchHR(line, offset, col, spaces) {
  const ind = indentFrom(line, offset, col, spaces);
  if (ind.indent > 3) return false;
  const j = ind.offset;
  const ch = line.charCodeAt(j);
  if (ch !== 45 && ch !== 95 && ch !== 42) return false;
  let count = 0;
  let k = j;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c === ch) {
      count++;
      k++;
    } else if (c === 32 || c === 9) {
      k++;
    } else {
      return false;
    }
  }
  return count >= 3;
}

function matchSetext(line, offset, col, spaces) {
  const ind = indentFrom(line, offset, col, spaces);
  if (ind.indent > 3) return 0;
  const j = ind.offset;
  const ch = line.charCodeAt(j);
  if (ch !== 61 && ch !== 45) return 0;
  let k = j;
  while (k < line.length && line.charCodeAt(k) === ch) k++;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return 0;
    k++;
  }
  return ch === 61 ? 1 : 2;
}

function matchQuote(line, offset, col, spaces) {
  const ind = indentFrom(line, offset, col, spaces);
  if (ind.indent > 3) return null;
  if (line.charCodeAt(ind.offset) !== 62) return null;
  return advCols(line, ind.offset + 1, ind.col + 1, 0, 1);
}

function matchListItem(line, offset, col, spaces) {
  const ind = indentFrom(line, offset, col, spaces);
  if (ind.indent > 3) return null;
  const j = ind.offset;
  const ch = line.charCodeAt(j);
  let ordered = false;
  let start = 0;
  let delim = '';
  let bullet = '';
  let markerEnd;
  if (ch === 45 || ch === 43 || ch === 42) {
    bullet = String.fromCharCode(ch);
    markerEnd = j + 1;
  } else if (ch >= 48 && ch <= 57) {
    let k = j;
    let num = 0;
    let digits = 0;
    while (
      k < line.length &&
      line.charCodeAt(k) >= 48 &&
      line.charCodeAt(k) <= 57 &&
      digits < 10
    ) {
      num = num * 10 + (line.charCodeAt(k) - 48);
      digits++;
      k++;
    }
    if (digits === 0 || digits > 9) return null;
    if (k >= line.length) return null;
    const d = line.charCodeAt(k);
    if (d !== 46 && d !== 41) return null;
    ordered = true;
    start = num;
    delim = String.fromCharCode(d);
    markerEnd = k + 1;
  } else {
    return null;
  }
  const markerWidth = markerEnd - j;
  const markerCol = ind.col + markerWidth;
  if (markerEnd >= line.length) {
    return {
      ordered,
      start,
      delim,
      bullet,
      pad: ind.indent + markerWidth + 1,
      empty: true,
      content: null,
    };
  }
  const c2 = line.charCodeAt(markerEnd);
  if (c2 !== 32 && c2 !== 9) return null;
  let k = markerEnd;
  let sp = 0;
  let ccol = markerCol;
  while (k < line.length) {
    const cc = line.charCodeAt(k);
    if (cc === 32) {
      sp++;
      k++;
      ccol++;
    } else if (cc === 9) {
      const w = 4 - (ccol % 4);
      sp += w;
      k++;
      ccol += w;
    } else {
      break;
    }
  }
  if (k >= line.length) {
    return {
      ordered,
      start,
      delim,
      bullet,
      pad: ind.indent + markerWidth + 1,
      empty: true,
      content: null,
    };
  }
  const skip = sp >= 5 ? 1 : sp;
  const pad = ind.indent + markerWidth + skip;
  const content = advCols(line, markerEnd, markerCol, 0, skip);
  return {
    ordered,
    start,
    delim,
    bullet,
    pad,
    empty: false,
    content,
  };
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'section',
  'source', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

const RE_HTML_TYPE1 = /^<(pre|script|style|textarea)(?:[ \t>]|$)/i;
const RE_HTML_TYPE6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t/>]|$)/;

function matchHtmlBlock(line, offset, col, spaces) {
  const ind = indentFrom(line, offset, col, spaces);
  if (ind.indent > 3) return null;
  const j = ind.offset;
  if (line.charCodeAt(j) !== 60) return null;
  const rest = line.slice(j);
  const m1 = RE_HTML_TYPE1.exec(rest);
  if (m1) return { type: 1, endTag: '</' + m1[1].toLowerCase() + '>', first: j };
  if (rest.startsWith('<!--')) return { type: 2, endTag: '-->', first: j };
  if (rest.startsWith('<?')) return { type: 3, endTag: '?>', first: j };
  if (rest.length > 2 && rest.charCodeAt(1) === 33) {
    const c2 = rest.charCodeAt(2);
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) {
      return { type: 4, endTag: '>', first: j };
    }
  }
  if (rest.startsWith('<![CDATA[')) {
    return { type: 5, endTag: ']]>', first: j };
  }
  const m6 = RE_HTML_TYPE6.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) {
    if (rest.charCodeAt(1) === 47) {
      // Closing tag: only whitespace then '>' may follow the name.
      let k = 2 + m6[1].length;
      while (k < rest.length) {
        const c = rest.charCodeAt(k);
        if (c !== 32 && c !== 9) break;
        k++;
      }
      if (k < rest.length && rest.charCodeAt(k) === 62) {
        return { type: 6, endTag: null, first: j };
      }
      // A closing tag with attributes is not a tag at all.
    } else {
      return { type: 6, endTag: null, first: j };
    }
  }
  const tag = parseHtmlTag(line, j);
  if (tag) {
    let k = tag.end;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) break;
      k++;
    }
    if (k >= line.length) return { type: 7, endTag: null, first: j };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Link reference definitions and tables (resolved at paragraph finalization).
// ---------------------------------------------------------------------------

function skipSpacesTabs(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else break;
  }
  return i;
}

// Try to parse one link reference definition at text[pos] (a line start).
// Returns { label, dest, title, end } or null. end is the start of the next
// line (or text.length).
function parseOneDef(text, pos) {
  const n = text.length;
  // A definition may be indented up to 3 columns (pos is a line start).
  let col = 0;
  let p = pos;
  while (p < n) {
    const c0 = text.charCodeAt(p);
    if (c0 === 32) {
      col++;
      p++;
    } else if (c0 === 9) {
      col += 4 - (col % 4);
      p++;
    } else break;
    if (col > 3) return null;
  }
  if (p >= n || text.charCodeAt(p) !== 91) return null;
  let j = p + 1;
  let labelEnd = -1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 93) {
      labelEnd = j;
      break;
    }
    if (c === 91) return null;
    if (c === 92 && j + 1 < n && isAsciiPunct(text.charCodeAt(j + 1))) {
      j += 2;
      continue;
    }
    j++;
  }
  if (labelEnd < 0) return null;
  // Labels match on their raw form (escapes are NOT resolved for
  // matching: [foo\!] does not match a [foo!] definition).
  const rawLabel = text.slice(p + 1, labelEnd);
  const label = normalizeLabel(rawLabel);
  if (label === '' || rawLabel.length > 999) return null;
  if (labelEnd + 1 >= n || text.charCodeAt(labelEnd + 1) !== 58) return null;
  const k = skipWs(text, labelEnd + 2);
  const d = parseDest(text, k);
  if (!d) return null;
  // A definition's destination may not be empty — except the <> form,
  // which is a valid empty destination.
  if (d.dest === '' && text.charCodeAt(k) !== 60) return null;
  let title = null;
  let k2 = skipWs(text, d.end);
  // A title must be separated from the destination by whitespace.
  const t = k2 > d.end ? parseTitle(text, k2) : null;
  if (t) {
    const afterTitle = skipSpacesTabs(text, t.end);
    if (afterTitle >= n || text.charCodeAt(afterTitle) === 10) {
      title = t.title;
      k2 = afterTitle;
    } else {
      // Title with trailing junk: fall back to a title-less definition
      // (valid only if the destination's own line ends cleanly).
      k2 = skipSpacesTabs(text, d.end);
      if (k2 < n && text.charCodeAt(k2) !== 10) return null;
    }
  } else {
    k2 = skipSpacesTabs(text, d.end);
  }
  if (k2 < n && text.charCodeAt(k2) !== 10) return null;
  return {
    label,
    dest: d.dest,
    title,
    end: k2 < n ? k2 + 1 : k2,
  };
}

// Strip the leading link reference definitions from a paragraph, recording
// them in refs (first definition wins). Returns the remaining text (lines
// joined with \n) or null when nothing remains.
function stripLinkDefs(para, refs) {
  const text = para.lines.join('\n');
  let pos = 0;
  const n = text.length;
  let anyDef = false;
  for (;;) {
    const def = parseOneDef(text, pos);
    if (!def) break;
    if (!refs.has(def.label)) {
      refs.set(def.label, { dest: def.dest, title: def.title });
    }
    anyDef = true;
    pos = def.end;
    if (pos >= n) break;
  }
  if (!anyDef) return text;
  if (pos >= n) return null;
  return text.slice(pos);
}

function trimSpaces(s) {
  let a = 0;
  let b = s.length;
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return s.slice(a, b);
}

// Split a table row on unescaped pipes; strip a leading/trailing pipe.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  if (i < n && line.charCodeAt(i) === 124) i++;
  for (; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      // An escaped pipe is consumed by the split (the cell keeps a plain
      // |, so it renders inside code spans too); other escapes are left
      // for the inline parser.
      if (line.charCodeAt(i + 1) === 124) cur += '|';
      else cur += line[i] + line[i + 1];
      i++;
      continue;
    }
    if (c === 124) {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += line[i];
  }
  cells.push(cur);
  let e = n - 1;
  while (e >= 0) {
    const c = line.charCodeAt(e);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  if (e >= 0 && line.charCodeAt(e) === 124 && cells.length > 1) {
    cells.pop();
  }
  return cells.map(trimSpaces);
}

const RE_DELIM_CELL = /^:?-+:?$/;

function parseDelimRow(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!RE_DELIM_CELL.test(cell)) return null;
    const left = cell.charCodeAt(0) === 58;
    const right = cell.charCodeAt(cell.length - 1) === 58;
    aligns.push(
      left && right ? 'center' : left ? 'left' : right ? 'right' : null,
    );
  }
  return aligns;
}

// Try to read a paragraph's remaining text as a GFM table.
function tryTable(text) {
  const lines = text.split('\n');
  if (lines.length < 2) return null;
  // The delimiter row may be indented at most 3 columns.
  let dcol = 0;
  for (let i = 0; i < lines[1].length; i++) {
    const c = lines[1].charCodeAt(i);
    if (c === 32) dcol++;
    else if (c === 9) dcol += 4 - (dcol % 4);
    else break;
  }
  if (dcol > 3) return null;
  const header = splitTableRow(lines[0]);
  const aligns = parseDelimRow(lines[1]);
  if (!aligns || aligns.length !== header.length) return null;
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitTableRow(lines[i]);
    while (cells.length < header.length) cells.push('');
    rows.push(cells.slice(0, header.length));
  }
  return { headCells: header, aligns, rows };
}

// Line tracking for the loose-list rule (parseBlocks is single-threaded
// and synchronous, so module state is safe here): pbLineIdx is the line
// currently processed, pbLastBlank the index of the most recent blank line.
// A child added to an item right after a blank line means the item has two
// children separated by a blank line (loose).
let pbLineIdx = 0;
let pbLastBlank = -1;
let pbBlankWasItem = false;

// ---------------------------------------------------------------------------
// Block parser: the main line loop.
// ---------------------------------------------------------------------------

function parseBlocks(lines, endsWithNL, ctx) {
  const root = mkBlock('doc', null);
  pbLastBlank = -1;

  function finalizePara(b) {
    let text = stripLinkDefs(b, ctx.refs);
    if (b.t === 'head' && text !== null) {
      // A setext heading's content is trimmed (a paragraph's is not).
      text = text.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
    }
    b.text = text;
    if (b.t === 'para' && text !== null) {
      const table = tryTable(text);
      if (table) {
        b.t = 'table';
        b.headCells = table.headCells;
        b.aligns = table.aligns;
        b.rows = table.rows;
      }
    }
  }

  function finalizeBlock(b) {
    b.open = false;
    if (b.t === 'para' || b.t === 'head') {
      finalizePara(b);
    } else if (b.t === 'code' && !b.fenced) {
      while (b.lines.length > 0) {
        const s = b.lines[b.lines.length - 1].s;
        let allWs = true;
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i);
          if (c !== 32 && c !== 9) {
            allWs = false;
            break;
          }
        }
        if (!allWs) break;
        b.lines.pop();
      }
    } else if (b.t === 'list') {
      // Loose if a blank line separated two items, or any item has two
      // children separated by a blank line.
      let tight = !b.looseByBlank;
      if (tight) {
        for (let i = 0; i < b.ch.length; i++) {
          if (b.ch[i].hadChildAfterBlank) {
            tight = false;
            break;
          }
        }
      }
      b.tight = tight;
    }
  }

  function deepestOpen() {
    let b = root;
    for (;;) {
      const last = lastOpenChild(b);
      if (!last) return b;
      b = last;
    }
  }

  function finalizeUpTo(container) {
    let tip = deepestOpen();
    while (tip !== container) {
      finalizeBlock(tip);
      tip = tip.parent;
    }
  }

  for (let li = 0; li < lines.length; li++) {
    pbLineIdx = li;
    const line = lines[li];
    const terminated = li < lines.length - 1 || endsWithNL;
    let offset = 0;
    let col = 0;
    let spaces = 0;
    let container = root;
    let leaf = null;
    let matchedContainer = false;

    // Phase 1: match open containers.
    for (;;) {
      const last = lastOpenChild(container);
      if (!last) break;
      if (last.t === 'quote') {
        const m = matchQuote(line, offset, col, spaces);
        if (!m) break;
        offset = m.offset;
        col = m.col;
        spaces = m.spaces;
        container = last;
        matchedContainer = true;
      } else if (last.t === 'item') {
        if (blankFrom(line, offset)) {
          offset = line.length;
          spaces = 0;
          container = last;
          matchedContainer = true;
        } else {
          const ind = indentFrom(line, offset, col, spaces);
          if (ind.indent < last.pad) break;
          const a = advCols(line, offset, col, spaces, last.pad);
          offset = a.offset;
          col = a.col;
          spaces = a.spaces;
          container = last;
          matchedContainer = true;
        }
      } else if (last.t === 'list') {
        container = last;
      } else {
        leaf = last;
        break;
      }
    }

    // Phase 1b: open leaf consumption (code, html).
    if (leaf && leaf.t === 'code' && leaf.fenced) {
      if (
        isClosingFence(line, offset, col, spaces, leaf.fenceCh, leaf.fenceLen)
      ) {
        finalizeBlock(leaf);
      } else {
        leaf.lines.push({
          s: contentAfter(line, offset, col, spaces, leaf.fenceIndent),
          term: terminated,
        });
      }
      continue;
    }
    if (leaf && leaf.t === 'code' && !leaf.fenced) {
      if (blankFrom(line, offset)) {
        leaf.lines.push({
          s: contentAfter(line, offset, col, spaces, 4),
          term: terminated,
        });
        continue;
      }
      const ind = indentFrom(line, offset, col, spaces);
      if (ind.indent >= 4) {
        leaf.lines.push({
          s: contentAfter(line, offset, col, spaces, 4),
          term: terminated,
        });
        continue;
      }
      finalizeBlock(leaf);
      leaf = null;
    }
    if (leaf && leaf.t === 'html') {
      if (leaf.htmlType >= 6 && blankFrom(line, offset)) {
        finalizeBlock(leaf);
        leaf = null;
      } else {
        leaf.lines.push({
          s: contentAfter(line, offset, col, spaces, 0),
          term: terminated,
        });
        if (leaf.htmlType <= 5 && leaf.endTag) {
          if (line.toLowerCase().indexOf(leaf.endTag) >= 0) {
            finalizeBlock(leaf);
          }
        }
        continue;
      }
    }

    // Phase 2: blank line. A line is blank when nothing remains after
    // container matching, or when no container matched and the rest is
    // all whitespace. (A quote line like `>  ` leaves a space behind,
    // which marked keeps as paragraph content, so it is not blank.)
    const isBlank =
      blankFrom(line, offset) &&
      (offset >= line.length || !matchedContainer);
    if (isBlank) {
      finalizeUpTo(container);
      pbLastBlank = li;
      pbBlankWasItem = container.t === 'item';
      // A blank line closes an empty list item.
      if (container.t === 'item' && container.ch.length === 0) {
        finalizeBlock(container);
      }
      continue;
    }

    // Phase 3: finalize unmatched containers, then try leaf starts.
    // An open paragraph is NOT finalized yet: it may continue on this
    // line (directly, or lazily when its containers did not match).
    // A lazy paragraph does not block leaf starts (setext, empty items,
    // type-7 HTML, indented code): those live in another container.
    let openPara = null;
    let openParaLazy = false;
    if (leaf && leaf.t === 'para') {
      openPara = leaf;
    } else {
      const tip = deepestOpen();
      if (tip.t === 'para') {
        openPara = tip;
        openParaLazy = true;
      } else {
        finalizeUpTo(container);
      }
    }
    // A new block (other than a list item) cannot be a direct child of a
    // list: if phase 1 stopped inside a list, use the list's parent.
    if (container.t === 'list') container = container.parent;
    // Interrupt the open paragraph (if any) and close the unmatched
    // containers up to the current container before starting a block.
    const interrupt = () => {
      if (openPara) {
        finalizeBlock(openPara);
        openPara = null;
        openParaLazy = false;
      }
      finalizeUpTo(container);
    };
    let consumed = false;

    for (;;) {
      if (blankFrom(line, offset)) {
        consumed = true;
        break;
      }
      const paraBlocks = openPara !== null && !openParaLazy;
      const atx = matchATX(line, offset, col, spaces);
      if (atx) {
        interrupt();
        const h = mkBlock('head', container);
        h.level = atx.level;
        h.lines = [atx.content];
        h.text = atx.content;
        h.open = false;
        consumed = true;
        break;
      }
      const fenced = matchFenced(line, offset, col, spaces);
      if (fenced) {
        interrupt();
        const code = mkBlock('code', container);
        code.fenced = true;
        code.info = fenced.info;
        code.fenceCh = fenced.fenceCh;
        code.fenceLen = fenced.fenceLen;
        code.fenceIndent = fenced.fenceIndent;
        code.lines = [];
        consumed = true;
        break;
      }
      const html = matchHtmlBlock(line, offset, col, spaces);
      if (html && (html.type <= 6 || !paraBlocks)) {
        interrupt();
        const hb = mkBlock('html', container);
        hb.htmlType = html.type;
        hb.endTag = html.endTag;
        hb.lines = [
          { s: contentAfter(line, offset, col, spaces, 0), term: terminated },
        ];
        if (
          html.type <= 5 &&
          html.endTag &&
          line.toLowerCase().indexOf(html.endTag, html.first + 1) >= 0
        ) {
          finalizeBlock(hb);
        }
        consumed = true;
        break;
      }
      if (paraBlocks) {
        const sx = matchSetext(line, offset, col, spaces);
        if (sx && stripLinkDefs(openPara, ctx.refs) !== null) {
          openPara.t = 'head';
          openPara.level = sx;
          finalizeBlock(openPara);
          openPara = null;
          openParaLazy = false;
          consumed = true;
          break;
        }
      }
      if (matchHR(line, offset, col, spaces)) {
        interrupt();
        const hr = mkBlock('hr', container);
        hr.open = false;
        consumed = true;
        break;
      }
      const item = matchListItem(line, offset, col, spaces);
      if (
        item &&
        (!paraBlocks || (!item.empty && (!item.ordered || item.start === 1)))
      ) {
        if (openPara) {
          finalizeBlock(openPara);
          openPara = null;
          openParaLazy = false;
        }
        let list = lastOpenChild(container);
        const reuse =
          list &&
          list.t === 'list' &&
          list.ordered === item.ordered &&
          list.delim === item.delim &&
          list.bullet === item.bullet;
        if (reuse) {
          // Reuse the open list: close the previous item, not the list.
          finalizeUpTo(list);
          // A new item right after a blank line (whose container was an
          // item, not a quote) separates two items: the list is loose.
          if (pbLastBlank === li - 1 && pbBlankWasItem) {
            list.looseByBlank = true;
          }
        } else {
          finalizeUpTo(container);
          list = mkBlock('list', container);
          list.ordered = item.ordered;
          list.start = item.start;
          list.delim = item.delim;
          list.bullet = item.bullet;
        }
        const it = mkBlock('item', list);
        it.pad = item.pad;
        container = it;
        if (item.empty) {
          consumed = true;
          break;
        }
        offset = item.content.offset;
        col = item.content.col;
        spaces = item.content.spaces;
        continue;
      }
      const q = matchQuote(line, offset, col, spaces);
      if (q) {
        interrupt();
        const quote = mkBlock('quote', container);
        container = quote;
        offset = q.offset;
        col = q.col;
        spaces = q.spaces;
        continue;
      }
      // Indented code cannot interrupt any open paragraph, lazy or not:
      // an indented line after a lazy paragraph is a lazy continuation.
      if (!openPara) {
        const ind = indentFrom(line, offset, col, spaces);
        if (ind.indent >= 4) {
          interrupt();
          const code = mkBlock('code', container);
          code.fenced = false;
          code.lines = [
            {
              s: contentAfter(line, offset, col, spaces, 4),
              term: terminated,
            },
          ];
          consumed = true;
          break;
        }
      }
      break;
    }

    if (consumed) continue;

    // Paragraph: continue the open one or start a new one. marked keeps
    // the line's leading spaces (only the container indent is removed),
    // except on lazy continuation lines, where they are stripped.
    let content;
    if (openPara && openParaLazy) {
      const ind = indentFrom(line, offset, col, spaces);
      content = line.slice(ind.offset);
    } else {
      content = contentAfter(line, offset, col, spaces, 0);
    }
    if (openPara) {
      openPara.lines.push(content);
    } else {
      const p = mkBlock('para', container);
      p.lines = [content];
    }
  }

  finalizeUpTo(root);
  return root;
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

function renderInlineText(text, ctx, out) {
  const list = parseInline(text, ctx);
  renderInline(list.ch, out);
}

// GFM task list: a paragraph starting with "[ ] " or "[x] "/"[X] ".
// Returns { checked, rest } where rest keeps the space after the bracket,
// or null.
function matchTask(text) {
  if (text.length < 4) return null;
  if (text.charCodeAt(0) !== 91) return null;
  if (text.charCodeAt(2) !== 93) return null;
  if (text.charCodeAt(3) !== 32) return null;
  const c1 = text.charCodeAt(1);
  if (c1 === 32) return { checked: false, rest: text.slice(3) };
  if (c1 === 120 || c1 === 88) return { checked: true, rest: text.slice(3) };
  return null;
}

function renderBlock(b, ctx, out, inTightList) {
  switch (b.t) {
    case 'doc':
      for (const c of b.ch) renderBlock(c, ctx, out, false);
      break;
    case 'para': {
      if (b.text === null) break;
      if (inTightList) {
        renderInlineText(b.text, ctx, out);
      } else {
        out.push('<p>');
        renderInlineText(b.text, ctx, out);
        out.push('</p>\n');
      }
      break;
    }
    case 'head': {
      out.push('<h', String(b.level), '>');
      renderInlineText(b.text || '', ctx, out);
      out.push('</h', String(b.level), '>\n');
      break;
    }
    case 'code': {
      let lit = '';
      for (const l of b.lines) lit += l.s + (l.term ? '\n' : '');
      out.push('<pre><code');
      if (b.fenced && b.info) {
        let w = 0;
        while (w < b.info.length) {
          const c = b.info.charCodeAt(w);
          if (c === 32 || c === 9) break;
          w++;
        }
        out.push(
          ' class="language-',
          cleanAttr(unescapeBackslashes(b.info.slice(0, w))),
          '"',
        );
      }
      out.push('>', escapeHtml(lit), '</code></pre>\n');
      break;
    }
    case 'html': {
      for (const l of b.lines) {
        out.push(l.s);
        if (l.term) out.push('\n');
      }
      break;
    }
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'quote':
      out.push('<blockquote>\n');
      for (const c of b.ch) renderBlock(c, ctx, out, false);
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
      for (const item of b.ch) renderBlock(item, ctx, out, false);
      out.push(b.ordered ? '</ol>\n' : '</ul>\n');
      break;
    }
    case 'item': {
      const tight = b.parent.tight;
      out.push('<li>');
      let first = true;
      for (const c of b.ch) {
        if (first && c.t === 'para' && c.text !== null) {
          const task = matchTask(c.text);
          if (task) {
            const box = task.checked
              ? '<input checked="" disabled="" type="checkbox">'
              : '<input disabled="" type="checkbox">';
            if (tight) {
              out.push(box);
              renderInlineText(task.rest, ctx, out);
            } else {
              out.push('<p>');
              out.push(box);
              renderInlineText(task.rest, ctx, out);
              out.push('</p>\n');
            }
            first = false;
            continue;
          }
        }
        renderBlock(c, ctx, out, tight);
        first = false;
      }
      out.push('</li>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let i = 0; i < b.headCells.length; i++) {
        out.push('<th');
        if (b.aligns[i]) out.push(' align="', b.aligns[i], '"');
        out.push('>');
        renderInlineText(b.headCells[i], ctx, out);
        out.push('</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (b.rows.length > 0) {
        out.push('<tbody>');
        for (const row of b.rows) {
          out.push('<tr>\n');
          for (let i = 0; i < row.length; i++) {
            out.push('<td');
            if (b.aligns[i]) out.push(' align="', b.aligns[i], '"');
            out.push('>');
            renderInlineText(row[i], ctx, out);
            out.push('</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function parse(src) {
  const norm = src.replace(/\r\n?/g, '\n');
  const endsWithNL = norm.endsWith('\n');
  const lines = norm.split('\n');
  if (endsWithNL) lines.pop();
  const ctx = { refs: new Map(), inLink: false };
  const root = parseBlocks(lines, endsWithNL, ctx);
  const out = [];
  renderBlock(root, ctx, out, false);
  return out.join('');
}
