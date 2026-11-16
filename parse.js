// parse.js — a dependency-free CommonMark 0.31.2 + GFM (0.29 extensions) Markdown parser
// written from scratch for the make.fun "Make Markdown rendering faster" bounty.
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with default options
// (GFM on, breaks off). Single-pass block parser + inline scanner, emitting HTML directly.
//
// Design notes (mine, not marked's): the input is split into lines once; a container stack
// (block quotes, lists, items) is matched line by line; leaf blocks accumulate their raw
// text; link reference definitions are pulled out of paragraphs when they finalize; inline
// parsing runs per block at render time, after every definition in the document is known.
// Inline parsing scans once into a flat item list, resolves links with a bracket stack,
// resolves emphasis with a forward scan per opener, then renders.

/* ------------------------------------------------------------------ */
/* Character helpers                                                   */
/* ------------------------------------------------------------------ */

// ASCII punctuation (CommonMark): !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
const ASCII_PUNCT = new Uint8Array(128);
for (const c of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') ASCII_PUNCT[c.charCodeAt(0)] = 1;

const PUNCT_RE = /[\p{P}\p{S}]/u; // Unicode punctuation + symbols, non-ASCII only (the spec counts symbols as punctuation for emphasis flanking: $, £, €)
const ZS_RE = /\p{Zs}/u; // Unicode space separators, for non-ASCII chars only
const ALNUM_RE = /[\p{L}\p{N}]/u; // Unicode letters + numbers, for the '_' intra-word rule

function isSpace(ch) {
  // CommonMark "Unicode whitespace": space, tab, LF, FF, CR + Zs category.
  // ch is a full code point.
  if (ch === 32 || ch === 9 || ch === 10 || ch === 12 || ch === 13) return true;
  if (ch < 128) return false;
  return ZS_RE.test(String.fromCodePoint(ch));
}

function isPunct(ch) {
  // ch is a full code point.
  if (ch < 128) return ASCII_PUNCT[ch] === 1;
  return PUNCT_RE.test(String.fromCodePoint(ch));
}

function isDigit(ch) {
  return ch >= 48 && ch <= 57;
}

function isAlpha(ch) {
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122);
}

function isWord(ch) {
  // \w : [A-Za-z0-9_]
  return (ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95;
}

// Resolve backslash escapes of ASCII punctuation in `s` (used for fence
// info strings, where marked unescapes the language).
function unescapePunct(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && ASCII_PUNCT[s.charCodeAt(i + 1)] === 1) {
      out += s.slice(start, i) + s[i + 1];
      start = i + 2;
      i++;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

/* ------------------------------------------------------------------ */
/* Escaping (matching marked's escape())                               */
/* ------------------------------------------------------------------ */

// marked's text escape: & < > " ' are escaped, EXCEPT an & that begins something
// looking like an entity reference: &#decimal; (1-7 digits), &#xhex; (1-6 hex digits),
// or &word; (ASCII word chars). Named entities are never validated or decoded;
// they pass through untouched.
function escText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      // look ahead: entity-like?
      let j = i + 1;
      if (s.charCodeAt(j) === 35) { // #
        j++;
        if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { // x or X
          j++;
          let n = 0;
          while (n < 6) {
            const h = s.charCodeAt(j);
            if ((h >= 48 && h <= 57) || (h >= 65 && h <= 70) || (h >= 97 && h <= 102)) { j++; n++; }
            else break;
          }
          if (n > 0 && s.charCodeAt(j) === 59) continue; // &#x...; stays
        } else {
          let n = 0;
          while (n < 7 && isDigit(s.charCodeAt(j))) { j++; n++; }
          if (n > 0 && s.charCodeAt(j) === 59) continue; // &#...; stays
        }
      } else {
        let n = 0;
        while (isWord(s.charCodeAt(j))) { j++; n++; }
        if (n > 0 && s.charCodeAt(j) === 59) continue; // &word; stays
      }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// marked's escape(x, true): every & < > " ' is escaped (code spans and code blocks).
function escAll(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode a numeric character reference starting at s[i] === '&' (s[i+1] === '#').
// Returns { ch, next } with the decoded string and the index after the ';',
// or null when it is not a valid numeric reference (bad digits, too many digits).
function decodeNumericRef(s, i) {
  let j = i + 2; // skip &#
  let hex = false;
  const c0 = s.charCodeAt(j);
  if (c0 === 120 || c0 === 88) { hex = true; j++; }
  let val = 0;
  let n = 0;
  const maxDigits = hex ? 6 : 7;
  while (n < maxDigits) {
    const c = s.charCodeAt(j);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    else break;
    val = val * (hex ? 16 : 10) + d;
    j++;
    n++;
  }
  if (n === 0 || s.charCodeAt(j) !== 59) return null; // needs ';'
  if (val === 0 || val > 0x10ffff || (val >= 0xd800 && val <= 0xdfff)) return { ch: '\uFFFD', next: j + 1 };
  return { ch: String.fromCodePoint(val), next: j + 1 };
}

/* ------------------------------------------------------------------ */
/* URLs (matching marked's cleanUrl + renderer)                        */
/* ------------------------------------------------------------------ */

// marked's cleanUrl: encodeURI, then %25 back to % (so %20 stays %20),
// and null when it throws (lone surrogate). A null href makes a
// link/image/autolink render as its plain text.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

function renderHref(href) {
  const clean = cleanUrl(href);
  if (clean === null) return null;
  return escText(clean);
}

/* ------------------------------------------------------------------ */
/* Link labels                                                         */
/* ------------------------------------------------------------------ */

// Normalize a link label: trim, fold runs of whitespace to one space, then
// the triple case-fold marked uses (toLowerCase().toUpperCase().toLowerCase()).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Inline parsing                                                      */
/*                                                                     */
/* Items in a parsed inline list:                                      */
/*   string            text run                                            */
/*   {v}               escape / numeric-reference character (non-text)   */
/*   {d,n,p,q}         delimiter run (d: 42 '*', 95 '_', 126 '~'; p/q:    */
/*                     code points before/after the run in the masked    */
/*                     source, -1 when absent)                           */
/*   {c}               code span                                       */
/*   {h}               raw HTML                                        */
/*   {b}               hard break (<br>)                                */
/*   {a,t}             <...> autolink (href already cleaned+escaped)   */
/*   {g,t}             GFM autolink candidate (link iff not inLink)    */
/*   {l,ti,k}          link (href null => render children only)        */
/*   {i,ti,k}          image (href null => render alt text only)       */
/*   {e,k} / {s,k}     emphasis / strong (children)                    */
/*   {x,k}             strikethrough (children)                        */
/* ------------------------------------------------------------------ */

function cpBefore(s, i) {
  if (i <= 0) return -1;
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return (hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
  }
  return lo;
}

function cpAt(s, i) {
  if (i >= s.length) return -1;
  const hi = s.charCodeAt(i);
  if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return (hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
  }
  return hi;
}

// Skip ASCII spaces/tabs/newlines; returns the new index.
function skipWS(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Parse a link destination starting at s[i]. Returns { dest, next, depth }
// (depth is the final paren depth for bare destinations; 0 for <...>) or null.
function parseLinkDest(s, i) {
  if (s.charCodeAt(i) === 60) { // <
    let out = '';
    let j = i + 1;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 62) return { dest: out, next: j + 1, depth: 0 }; // >
      if (c === 10 || c === 60) return null; // line ending or < ends it badly
      if (c === 92 && j + 1 < s.length && ASCII_PUNCT[s.charCodeAt(j + 1)] === 1) {
        out += s[j + 1];
        j += 2;
      } else {
        out += s[j];
        j++;
      }
    }
    return null;
  }
  // Bare destination: no spaces or control chars, balanced parens.
  let out = '';
  let j = i;
  let depth = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 0 || c < 32 || c === 127) break;
    if (c === 92 && j + 1 < s.length && ASCII_PUNCT[s.charCodeAt(j + 1)] === 1) {
      out += s[j + 1];
      j += 2;
      continue;
    }
    if (c === 40) { depth++; out += s[j]; j++; continue; } // (
    if (c === 41) { // )
      if (depth === 0) break;
      depth--;
      out += s[j];
      j++;
      continue;
    }
    out += s[j];
    j++;
  }
  return { dest: out, next: j, depth };
}

// Parse a link title starting at s[i] (one of " ' (). Returns { title, next } or null.
// A line ending inside a title is kept literally (marked keeps the \n).
function parseLinkTitle(s, i) {
  const q = s.charCodeAt(i);
  if (q !== 34 && q !== 39 && q !== 40) return null;
  const close = q === 40 ? 41 : q;
  let out = '';
  let j = i + 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === close) return { title: out, next: j + 1 };
    if (q === 40 && c === 40) return null; // ( inside a (...) title
    if (c === 92 && j + 1 < s.length && ASCII_PUNCT[s.charCodeAt(j + 1)] === 1) {
      out += s[j + 1];
      j += 2;
      continue;
    }
    out += s[j];
    j++;
  }
  return null;
}

// Parse an inline link "(dest title)" starting at s[i] === '('. Returns
// { href, title, next } or null.
function parseInlineLink(s, i) {
  let j = skipWS(s, i + 1);
  const d = parseLinkDest(s, j);
  if (d === null) return null;
  j = skipWS(s, d.next);
  let title = null;
  const c = s.charCodeAt(j);
  if (c === 34 || c === 39 || c === 40) {
    const t = parseLinkTitle(s, j);
    if (t === null) return null;
    title = t.title;
    j = skipWS(s, t.next);
  }
  if (s.charCodeAt(j) !== 41) return null; // needs )
  return { href: d.dest, title, next: j + 1 };
}

// Is the source range [start, end) a balanced link label (every '[' matched
// by a later ']', no stray ']' — the label pattern requires balanced
// brackets)? Backslash escapes and code spans are opaque (their brackets
// do not count).
function labelBalanced(s, start, end) {
  let depth = 0;
  let j = start;
  while (j < end) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end) { j += 2; continue; } // escape
    if (c === 96) { // backtick: skip the code span if it closes in range
      let run = 0;
      while (j + run < end && s.charCodeAt(j + run) === 96) run++;
      let k = j + run;
      let closed = -1;
      while (k < end) {
        if (s.charCodeAt(k) === 96) {
          let r2 = 0;
          while (k + r2 < end && s.charCodeAt(k + r2) === 96) r2++;
          if (r2 === run) { closed = k + r2; break; }
          k += r2;
        } else k++;
      }
      if (closed !== -1) { j = closed; continue; }
      j += run;
      continue;
    }
    if (c === 91) { depth++; j++; continue; }
    if (c === 93) { depth--; if (depth < 0) return false; j++; continue; }
    j++;
  }
  return depth === 0;
}

// Parse a link label "[...]" starting at s[i] === '['. Returns { label, next }
// (label is the raw text between the brackets) or null.
function parseLinkLabel(s, i) {
  let j = i + 1;
  let out = '';
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 93) { // ]
      if (out.length > 999) return null;
      return { label: out, next: j + 1 };
    }
    if (c === 91) return null; // unescaped [ inside a label
    // Keep the backslash: marked matches labels in their raw (escaped) form,
    // so "[\*a]" only matches a definition written "[\*a]", not "[*a]".
    if (c === 92 && j + 1 < s.length && ASCII_PUNCT[s.charCodeAt(j + 1)] === 1) {
      out += s[j];
      out += s[j + 1];
      j += 2;
      continue;
    }
    out += s[j];
    j++;
  }
  return null;
}

// Is s[i] the start of an email local-part character (marked's set: the
// CommonMark set without '/')?
// Email local-part char per marked's GFM email regex: [A-Za-z0-9._+-].
function isEmailLocal(ch) {
  if (ch < 128) {
    return (
      (ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) ||
      ch === 43 || ch === 45 || ch === 46 || ch === 95
    );
  }
  return false;
}

function isDomainChar(ch) {
  return (ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 45 || ch === 95;
}

// Match an email address starting at s[i]. Returns { email, next } or null.
// Local part + @ + domain with at least one dot, labels of at most 63 chars.
// Mirrors marked's email regex: the final label must end with an
// alphanumeric, a '.' only continues the domain when a label follows it
// (a trailing '.' is not part of the email), and the char after the email
// must not be a word char or '-' (the (?![\w-]) lookahead).
function matchEmail(s, i) {
  let j = i;
  while (j < s.length && isEmailLocal(s.charCodeAt(j))) j++;
  if (j === i || s.charCodeAt(j) !== 64) return null; // needs @
  j++;
  const domainStart = j;
  let labels = 0;
  // Record the end offset after each label, for backtracking.
  const labelEnds = [];
  while (true) {
    const start = j;
    if (!isDomainChar(s.charCodeAt(j))) return null;
    while (j < s.length && isDomainChar(s.charCodeAt(j)) && j - start < 63) j++;
    if (j - start > 63) return null;
    labels++;
    labelEnds.push(j);
    // A '.' continues the domain only when a label follows it.
    if (s.charCodeAt(j) === 46 && j + 1 < s.length && isDomainChar(s.charCodeAt(j + 1))) { j++; continue; }
    break;
  }
  if (labels < 2) return null;
  // Negative lookahead: the next char must not be a word char or '-'.
  // Marked's regex backtracks: if the longest domain fails the lookahead,
  // drop labels until it passes (or fewer than 2 labels remain).
  // Exception: a trailing _ or * that is a (potential) emphasis closer
  // does not block the email — marked resolves emphasis first, so the
  // closer is gone by the time the email is matched. It counts as a
  // closer when it is right-flanking and the same char opens earlier.
  for (let li = labelEnds.length - 1; li >= 1; li--) {
    let e = labelEnds[li];
    // The final label must end with an alphanumeric: strip trailing _
    // / - (they are domain chars, but a label cannot end with one).
    const labelStart = li === 0 ? domainStart : labelEnds[li - 1] + 1;
    while (e > labelStart && (s.charCodeAt(e - 1) === 95 || s.charCodeAt(e - 1) === 45)) e--;
    if (e === labelStart) continue;
    const last = s.charCodeAt(e - 1);
    if (!isAlpha(last) && !isDigit(last)) continue;
    if (e >= s.length) return { email: s.slice(i, e), next: e };
    const nc = s.charCodeAt(e);
    if (!isWord(nc) && nc !== 45) return { email: s.slice(i, e), next: e };
    // Lookahead failed on _ or *: emphasis-closer exception (only for the
    // longest domain — backtracked forms never end right before a closer).
    if (li === labelEnds.length - 1 && (nc === 95 || nc === 42)) {
      const after = e + 1 >= s.length ? -1 : s.charCodeAt(e + 1);
      const rightFlanking = after === -1 || isSpace(after) || isPunct(after);
      if (rightFlanking) {
        // Is there an opener of the same char before the email?
        for (let k = i - 1; k >= 0; k--) {
          if (s.charCodeAt(k) === nc) return { email: s.slice(i, e), next: e };
          if (s.charCodeAt(k) === 10) break;
        }
      }
    }
  }
  return null;
}

// Punctuation the GFM autolink rules may strip from the end of a link:
// ? ! . , : ; * _ ' " ~ and ). A run of these is kept only when more link
// text follows it; a run at the very end of the match is dropped.
function isAutolinkPunct(ch) {
  return ch === 63 || ch === 33 || ch === 46 || ch === 44 || ch === 58 ||
    ch === 59 || ch === 42 || ch === 95 || ch === 39 || ch === 34 ||
    ch === 126 || ch === 41;
}

// One backpedal pass over a raw GFM autolink match [start, end): scan the
// match as a run of pieces and return where the kept prefix ends. The
// pieces are: runs of ordinary chars (anything but the punctuation above,
// '(' and '&'); a parenthesised group '(' ... ')' with no ')' inside; an
// '&' that does not start an entity running to the end of the match; and a
// run of trailing punctuation followed by more match text. A piece that
// cannot complete ends the prefix there.
function backpedalOnce(s, start, end) {
  let i = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === 40) {
      // '(' opens a group only when a ')' closes it before the match ends.
      let j = i + 1;
      while (j < end && s.charCodeAt(j) !== 41) j++;
      if (j >= end) break;
      i = j + 1;
    } else if (c === 38) {
      // '&' is dropped only when it starts &alnum+; at the end of the match.
      let j = i + 1;
      while (j < end && (isAlpha(s.charCodeAt(j)) || isDigit(s.charCodeAt(j)))) j++;
      if (j > i + 1 && j < end && s.charCodeAt(j) === 59 && j === end - 1) break;
      i++;
    } else if (isAutolinkPunct(c)) {
      // A punctuation run is kept whole when more text follows it. When
      // it runs to the end of the match, leave its last char behind: the
      // next pass eats it, so a trailing run shrinks one char per pass.
      let j = i;
      while (j < end && isAutolinkPunct(s.charCodeAt(j))) j++;
      if (j >= end) { i = end - 1; break; }
      i = j;
    } else {
      while (i < end) {
        const d = s.charCodeAt(i);
        if (d === 40 || d === 38 || isAutolinkPunct(d)) break;
        i++;
      }
    }
  }
  return i;
}

// Trim a raw GFM autolink match [start, end): apply backpedal passes until
// the match stops shrinking. The repetition matters: dropping an unmatched
// ')' can expose trailing punctuation, and dropping that can expose more.
function trimAutolink(s, start, end) {
  let e = end;
  for (;;) {
    const next = backpedalOnce(s, start, e);
    if (next === e) return e;
    e = next;
  }
}

// Match a GFM autolink (www. / scheme / email) starting at s[i].
// Returns { href, text, next } or null. `prev` is the char before i in the
// source (or -1 at the start), used for the www. preceding-char rule.
function matchGfmAutolink(s, i, prev, stopAtBracket) {
  const c = s.charCodeAt(i);
  // www. (lowercase only), preceded by start / whitespace / * _ ~ (
  if (c === 119 && s.charCodeAt(i + 1) === 119 && s.charCodeAt(i + 2) === 119 && s.charCodeAt(i + 3) === 46) {
    if (prev === -1 || isSpace(prev) || prev === 42 || prev === 95 || prev === 126 || prev === 40) {
      let j = i + 4;
      while (j < s.length) {
        const ch = s.charCodeAt(j);
        if (isSpace(ch) || ch === 60 || ch === 62 || (stopAtBracket && ch === 93)) break;
        j++;
      }
      const e = trimAutolink(s, i, j);
      if (e > i + 4) {
        const text = s.slice(i, e);
        return { href: 'http://' + text, text, next: e };
      }
      return null;
    }
    return null;
  }
  // Schemes: http:// https:// ftp:// (case-insensitive), no preceding rule.
  let schemeLen = 0;
  const c1 = s.charCodeAt(i + 1) | 32;
  const c2 = s.charCodeAt(i + 2) | 32;
  const c3 = s.charCodeAt(i + 3) | 32;
  const c4 = s.charCodeAt(i + 4) | 32;
  if ((c | 32) === 104 && c1 === 116 && c2 === 116 && c3 === 112) {
    // http
    if (s.charCodeAt(i + 4) === 58 && s.charCodeAt(i + 5) === 47 && s.charCodeAt(i + 6) === 47) schemeLen = 7;
    else if (c4 === 115 && s.charCodeAt(i + 5) === 58 && s.charCodeAt(i + 6) === 47 && s.charCodeAt(i + 7) === 47) schemeLen = 8;
  } else if ((c | 32) === 102 && c1 === 116 && c2 === 112) {
    // ftp
    if (s.charCodeAt(i + 3) === 58 && s.charCodeAt(i + 4) === 47 && s.charCodeAt(i + 5) === 47) schemeLen = 6;
  }
  if (schemeLen > 0) {
    let j = i + schemeLen;
    while (j < s.length) {
      const ch = s.charCodeAt(j);
      if (isSpace(ch) || ch === 60 || ch === 62 || (stopAtBracket && ch === 93)) break;
      j++;
    }
    const e = trimAutolink(s, i, j);
    if (e > i + schemeLen) {
      const text = s.slice(i, e);
      return { href: text, text, next: e };
    }
    return null;
  }
  // mailto: (lowercase only) + email.
  if (c === 109 && s.slice(i, i + 7) === 'mailto:') {
    const m = matchEmail(s, i + 7);
    if (m) {
      const text = s.slice(i, m.next);
      return { href: text, text, next: m.next };
    }
    return null;
  }
  // xmpp: (lowercase only) + email + optional /path segment.
  if (c === 120 && s.slice(i, i + 5) === 'xmpp:') {
    const m = matchEmail(s, i + 5);
    if (m) {
      let e = m.next;
      if (s.charCodeAt(e) === 47) {
        let k = e + 1;
        while (k < s.length) {
          const ch = s.charCodeAt(k);
          if (isAlpha(ch) || isDigit(ch) || ch === 64 || ch === 46) k++;
          else break;
        }
        if (k > e + 1) e = k;
      }
      const text = s.slice(i, e);
      return { href: text, text, next: e };
    }
    return null;
  }
  return null;
}

// Match an HTML comment / processing instruction / declaration / CDATA
// starting at s[i] === '<'. Returns the index after the construct, or -1.
function matchHtmlSpecial(s, i) {
  if (s.charCodeAt(i + 1) === 33) { // <!
    if (s.charCodeAt(i + 2) === 45 && s.charCodeAt(i + 3) === 45) { // <!--
      // <!--> and <!---> are complete (empty) comments.
      if (s.charCodeAt(i + 4) === 62) return i + 5;
      if (s.charCodeAt(i + 4) === 45 && s.charCodeAt(i + 5) === 62) return i + 6;
      const e = s.indexOf('-->', i + 4);
      return e === -1 ? -1 : e + 3;
    }
    if (s.slice(i + 2, i + 9) === '[CDATA[') {
      const e = s.indexOf(']]>', i + 9);
      return e === -1 ? -1 : e + 3;
    }
    if (isAlpha(s.charCodeAt(i + 2))) { // <!A...
      const e = s.indexOf('>', i + 2);
      return e === -1 ? -1 : e + 1;
    }
    return -1;
  }
  if (s.charCodeAt(i + 1) === 63) { // <?
    const e = s.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  return -1;
}

// Match an inline HTML open/close tag starting at s[i] === '<'.
// Returns the index after the '>', or -1.
function matchHtmlTag(s, i) {
  let j = i + 1;
  const closed = s.charCodeAt(j) === 47;
  if (closed) j++; // /
  if (!isAlpha(s.charCodeAt(j))) return -1;
  j++;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isAlpha(c) || isDigit(c) || c === 45) j++;
    else break;
  }
  if (closed) {
    // Closing tags take no attributes: only whitespace, then >.
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10) j++;
      else break;
    }
    if (s.charCodeAt(j) === 62) return j + 1;
    return -1;
  }
  // Attributes / close.
  for (;;) {
    // Skip whitespace (may span lines).
    let k = j;
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10) k++;
      else break;
    }
    if (k >= s.length) return -1;
    const c = s.charCodeAt(k);
    if (c === 62) return k + 1; // >
    if (c === 47 && s.charCodeAt(k + 1) === 62) return k + 2; // />
    // An attribute must be preceded by whitespace.
    if (k === j) return -1;
    // Attribute name.
    const a0 = s.charCodeAt(k);
    if (!(isAlpha(a0) || a0 === 95 || a0 === 58)) return -1;
    let a = k + 1;
    while (a < s.length) {
      const ac = s.charCodeAt(a);
      if (isAlpha(ac) || isDigit(ac) || ac === 95 || ac === 58 || ac === 46 || ac === 45) a++;
      else break;
    }
    j = a;
    // Skip whitespace before = (without consuming it if there is no =:
    // the next attribute still needs its preceding whitespace).
    let w = j;
    while (w < s.length) {
      const wc = s.charCodeAt(w);
      if (wc === 32 || wc === 9 || wc === 10) w++;
      else break;
    }
    if (s.charCodeAt(w) !== 61) continue; // no value: boolean attribute
    j = w + 1;
    while (j < s.length) {
      const wc = s.charCodeAt(j);
      if (wc === 32 || wc === 9 || wc === 10) j++;
      else break;
    }
    if (j >= s.length) return -1;
    const q = s.charCodeAt(j);
    if (q === 34 || q === 39) {
      const e = s.indexOf(String.fromCharCode(q), j + 1);
      if (e === -1) return -1;
      j = e + 1;
    } else {
      // Unquoted value: one or more chars except space " ' = < > `
      let v = j;
      while (v < s.length) {
        const vc = s.charCodeAt(v);
        if (vc === 32 || vc === 9 || vc === 10 || vc === 34 || vc === 39 || vc === 61 ||
            vc === 60 || vc === 62 || vc === 96) break;
        v++;
      }
      if (v === j) return -1; // empty value is not a tag
      j = v;
    }
  }
}

// Match a <...> autolink starting at s[i] === '<'.
// Returns { href, text, next } or null. Scheme autolinks and email autolinks.
function matchAngleAutolink(s, i) {
  // Scheme: letter, then 1-31 letters/digits/+/-/. then ':' then no-space run.
  let j = i + 1;
  if (!isAlpha(s.charCodeAt(j))) {
    // Maybe an email autolink.
    const m = matchEmail(s, j);
    if (m && s.charCodeAt(m.next) === 62) {
      return { href: 'mailto:' + m.email, text: m.email, next: m.next + 1 };
    }
    return null;
  }
  let n = 1;
  j++;
  while (j < s.length && n < 32) {
    const c = s.charCodeAt(j);
    if (isAlpha(c) || isDigit(c) || c === 43 || c === 45 || c === 46) { j++; n++; }
    else break;
  }
  if (n < 2 || s.charCodeAt(j) !== 58) {
    // Not a scheme autolink; could still be an email starting with a letter.
    const m = matchEmail(s, i + 1);
    if (m && s.charCodeAt(m.next) === 62) {
      return { href: 'mailto:' + m.email, text: m.email, next: m.next + 1 };
    }
    return null;
  }
  j++;
  const start = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 62) {
      if (j === start) return null; // empty
      const text = s.slice(i + 1, j);
      return { href: text, text, next: j + 1 };
    }
    if (isSpace(c) || c === 60) return null;
    j++;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The inline scanner                                                  */
/* ------------------------------------------------------------------ */

// Scan src into a flat item list, resolving links/images with a bracket
// stack. Emphasis is resolved afterwards by resolveEmphasis().
function scanInline(src, refs) {
  const items = [];
  const brackets = []; // { idx, img, active, start }
  let textBuf = '';
  const flushText = () => {
    if (textBuf !== '') {
      items.push(textBuf);
      textBuf = '';
    }
  };
  // Push an escape or numeric-reference character as its own item (a token
  // boundary: marked escapes each text token on its own, so an & produced
  // by an escape or an entity must not join the &word; lookahead of what
  // follows it). These are {v} items, not strings: marked treats an escape
  // as a non-text token, so a delimiter run after one sees no previous
  // text character.
  const pushTextItem = (t) => {
    flushText();
    items.push({ v: t });
  };

  // The masked-source code point before the current position, for a
  // delimiter run starting here: the previous text character, or a
  // representative for a non-text token (escapes mask to '+', links and
  // code spans to '[...]', a hard break to a newline, a bare URL keeps its
  // last character). -1 when nothing precedes it.
  const prevCpForDelim = () => {
    if (textBuf !== '') return cpBefore(textBuf, textBuf.length);
    if (items.length === 0) return -1;
    const it = items[items.length - 1];
    if (typeof it === 'string') return cpBefore(it, it.length);
    if (it.v !== undefined) return 43; // '+'
    if (it.c !== undefined || it.l !== undefined || it.i !== undefined || it.h !== undefined || it.a !== undefined) return 93; // ']'
    if (it.g !== undefined) return it.t.length === 0 ? -1 : cpBefore(it.t, it.t.length);
    if (it.b !== undefined) return 10;
    if (it.d !== undefined) return it.d;
    return 93;
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);

    // Backslash escape, or backslash + newline = hard break.
    if (c === 92) {
      if (i + 1 < n) {
        const d = src.charCodeAt(i + 1);
        if (d === 10) {
          flushText();
          items.push({ b: 1 });
          i += 2;
          // A hard break consumes the following spaces/tabs (br regex
          // ends with [ \t]*).
          while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
          continue;
        }
        if (ASCII_PUNCT[d] === 1) {
          pushTextItem(src[i + 1]);
          i += 2;
          continue;
        }
      }
      textBuf += '\\';
      i++;
      continue;
    }

    // Code span.
    if (c === 96) {
      let run = 0;
      while (i + run < n && src.charCodeAt(i + run) === 96) run++;
      let j = i + run;
      let found = -1;
      while (j < n) {
        if (src.charCodeAt(j) === 96) {
          let r2 = 0;
          while (j + r2 < n && src.charCodeAt(j + r2) === 96) r2++;
          if (r2 === run) {
            found = j;
            break;
          }
          j += r2;
        } else {
          j++;
        }
      }
      if (found === -1) {
        textBuf += src.slice(i, i + run);
        i += run;
        continue;
      }
      let content = src.slice(i + run, found);
      if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
      if (
        content.length >= 2 &&
        content.charCodeAt(0) === 32 &&
        content.charCodeAt(content.length - 1) === 32
      ) {
        let allSpace = true;
        for (let k = 0; k < content.length; k++) {
          if (content.charCodeAt(k) !== 32) {
            allSpace = false;
            break;
          }
        }
        if (!allSpace) content = content.slice(1, -1);
      }
      flushText();
      items.push({ c: content });
      i = found + run;
      continue;
    }

    // Emphasis delimiter run. The resolver works out opening/closing
    // from the neighbouring characters in the masked source, so record
    // the code points around the run: p (before) and q (after).
    if (c === 42 || c === 95) {
      let run = 0;
      while (i + run < n && src.charCodeAt(i + run) === c) run++;
      const p = prevCpForDelim();
      const q = i + run < n ? cpAt(src, i + run) : -1;
      flushText();
      items.push({ d: c, n: run, p, q });
      i += run;
      continue;
    }

    // Strikethrough delimiter run: the resolver matches runs of the same
    // length (3+ tildes never form <del>).
    if (c === 126) {
      let run = 0;
      while (i + run < n && src.charCodeAt(i + run) === 126) run++;
      const p = prevCpForDelim();
      const q = i + run < n ? cpAt(src, i + run) : -1;
      flushText();
      items.push({ d: 126, n: run, p, q });
      i += run;
      continue;
    }

    // Link / image opener.
    if (c === 91) {
      flushText();
      items.push('[');
      brackets.push({ idx: items.length - 1, img: false, active: true, start: i + 1 });
      i++;
      continue;
    }
    if (c === 33 && src.charCodeAt(i + 1) === 91) {
      flushText();
      items.push('!');
      items.push('[');
      brackets.push({ idx: items.length - 1, img: true, active: true, start: i + 2 });
      i += 2;
      continue;
    }

    // Link / image closer: try inline, full reference, collapsed, shortcut.
    // Inline and full-reference labels may contain balanced brackets, so
    // those try openers earliest-first and take the first whose label is
    // balanced. Collapsed/shortcut labels may not contain brackets, so
    // they use the nearest opener.
    if (c === 93) {
      const nc = src.charCodeAt(i + 1);
      let br = null;
      let bi = -1;
      let link = null;
      const earliestBalanced = () => {
        for (let bj = 0; bj < brackets.length; bj++) {
          const b = brackets[bj];
          if (!b.active) continue;
          if (labelBalanced(src, b.start, i)) return { b, bj };
        }
        return null;
      };
      const nearest = () => {
        for (let nb = brackets.length - 1; nb >= 0; nb--) {
          if (brackets[nb].active) return { b: brackets[nb], bj: nb };
        }
        return null;
      };
      const tryShortcut = () => {
        const nr = nearest();
        if (nr === null) return;
        const ref = refs.get(normalizeLabel(src.slice(nr.b.start, i)));
        if (ref) { br = nr.b; bi = nr.bj; link = { href: ref.href, title: ref.title, next: i + 1 }; }
      };
      if (nc === 40) {
        const l = parseInlineLink(src, i + 1);
        if (l !== null) {
          const eb = earliestBalanced();
          if (eb !== null) { br = eb.b; bi = eb.bj; link = l; }
        }
        // A failed inline parse falls back to the shortcut.
        if (link === null) tryShortcut();
      } else if (nc === 91) {
        const lab = parseLinkLabel(src, i + 1);
        if (lab === null) {
          // Malformed [...] after ]: fall back to the shortcut.
          tryShortcut();
        } else if (lab.label === '') {
          // Collapsed reference: the label is the link text itself. Try
          // openers earliest-first; the first whose text is a defined
          // reference wins (a text containing brackets cannot be a
          // defined reference, so it is skipped naturally).
          for (let bj = 0; bj < brackets.length; bj++) {
            const b = brackets[bj];
            if (!b.active) continue;
            if (!labelBalanced(src, b.start, i)) continue;
            const ref = refs.get(normalizeLabel(src.slice(b.start, i)));
            if (ref) { br = b; bi = bj; link = { href: ref.href, title: ref.title, next: lab.next }; break; }
          }
        } else {
          const key = normalizeLabel(lab.label);
          if (key === '') {
            // Whitespace-only label is not a reference: shortcut fallback.
            tryShortcut();
          } else {
            // Full reference: no shortcut fallback if it fails.
            const ref = refs.get(key);
            if (ref) {
              const eb = earliestBalanced();
              if (eb !== null) { br = eb.b; bi = eb.bj; link = { href: ref.href, title: ref.title, next: lab.next }; }
            }
          }
        }
      } else {
        tryShortcut();
      }
      if (link === null || br === null) {
        textBuf += ']';
        i++;
        continue;
      }
      flushText();
      const children = items.slice(br.idx + 1);
      // A GFM candidate inside the link text may span past the closing ]
      // (its URL matched the ](dest) too). Truncate its text at the ].
      for (const ch of children) {
        if (typeof ch === 'object' && ch.g !== undefined && ch.s !== undefined && i > ch.s && i < ch.s + ch.t.length) {
          ch.t = ch.t.slice(0, i - ch.s);
        }
      }
      const removeFrom = br.img ? br.idx - 1 : br.idx;
      items.length = removeFrom;
      const href = cleanUrl(link.href);
      if (br.img) {
        items.push({ i: href, ti: link.title, k: children });
      } else {
        items.push({ l: href, ti: link.title, k: children });
        // Forming a link deactivates all open link brackets (a link's text
        // cannot contain another link), but NOT image openers: an image
        // may still form around the link (its alt text keeps the link's
        // text).
        for (const b of brackets) if (!b.img) b.active = false;
      }
      brackets.length = bi;
      i = link.next;
      continue;
    }

    // Autolink, HTML comment/PI/declaration/CDATA, or HTML tag.
    if (c === 60) {
      const auto = matchAngleAutolink(src, i);
      if (auto) {
        const href = cleanUrl(auto.href);
        flushText();
        if (href === null) items.push(auto.text);
        else items.push({ a: href, t: auto.text });
        i = auto.next;
        continue;
      }
      const sp = matchHtmlSpecial(src, i);
      if (sp !== -1) {
        flushText();
        items.push({ h: src.slice(i, sp) });
        i = sp;
        continue;
      }
      const tag = matchHtmlTag(src, i);
      if (tag !== -1) {
        flushText();
        items.push({ h: src.slice(i, tag) });
        i = tag;
        continue;
      }
      textBuf += '<';
      i++;
      continue;
    }

    // Numeric character reference (named ones pass through untouched).
    if (c === 38) {
      if (src.charCodeAt(i + 1) === 35) {
        const dec = decodeNumericRef(src, i);
        if (dec) {
          pushTextItem(dec.ch);
          i = dec.next;
          continue;
        }
      }
      textBuf += '&';
      i++;
      continue;
    }

    // Line ending: hard break after 2+ spaces/tabs, else a soft break.
    if (c === 10) {
      let k = textBuf.length;
      let spaces = 0;
      while (k > 0) {
        const tc = textBuf.charCodeAt(k - 1);
        if (tc === 32 || tc === 9) {
          spaces++;
          k--;
        } else break;
      }
      if (spaces >= 2) {
        textBuf = textBuf.slice(0, k);
        flushText();
        items.push({ b: 1 });
        i++;
        // A hard break consumes the following spaces/tabs.
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
      } else {
        textBuf += '\n';
        i++;
      }
      continue;
    }

    // GFM autolinks: www. / http(s):// / ftp:// / mailto: / xmpp:
    if (c === 119 || c === 104 || c === 72 || c === 102 || c === 70 || c === 109 || c === 120) {
      const prev = i === 0 ? -1 : src.charCodeAt(i - 1);
      // Inside an open link bracket, a GFM URL must not swallow the ]
      // that closes the link (marked matches the link first).
      let inBracket = false;
      for (let bi2 = 0; bi2 < brackets.length; bi2++) if (brackets[bi2].active) { inBracket = true; break; }
      const g = matchGfmAutolink(src, i, prev, inBracket);
      if (g) {
        const href = cleanUrl(g.href);
        flushText();
        if (href === null) items.push(g.text);
        else items.push({ g: href, t: g.text, s: i });
        i = g.next;
        continue;
      }
    }

    // GFM email autolink, tried at word starts.
    if (isEmailLocal(c) && (i === 0 || !isEmailLocal(src.charCodeAt(i - 1)))) {
      const m = matchEmail(src, i);
      if (m) {
        flushText();
        items.push({ g: 'mailto:' + m.email, t: m.email, s: i });
        i = m.next;
        continue;
      }
    }

    textBuf += src[i];
    i++;
  }
  flushText();
  return items;
}

/* ------------------------------------------------------------------ */
/* Emphasis (marked's forward-scan algorithm)                          */
/* ------------------------------------------------------------------ */

// Character class of a code point beside a delimiter run: 0 = absent,
// 1 = whitespace, 2 = punctuation/symbol, 3 = anything else. A tilde
// counts as a word character for '*' runs (GFM) and as punctuation
// for '_' and '~' runs.
function delimClass(cp, tildeWord) {
  if (cp === -1) return 0;
  if (cp === 126) return tildeWord ? 3 : 2;
  if (isSpace(cp)) return 1;
  if (isPunct(cp)) return 2;
  return 3;
}

function isAlnumCp(cp) {
  if (cp === -1) return false;
  return ALNUM_RE.test(String.fromCodePoint(cp));
}

// Try to match the delimiter run at items[oi] as an opener: scan forward
// over later runs of the same character, counting pending openers, and
// close when the count runs out. Runs that can both open and close (and,
// when the opener can also close, every closer) are skipped by the rule
// of 3 instead of closing. On a match, splices an em/strong/del node
// into the list (leftovers of the opener stay inside the node, leftovers
// of the closer past the adjusted length stay after it) and returns the
// index after the node; otherwise returns -1.
function tryMatchDelim(items, oi) {
  const opener = items[oi];
  const r = opener.d;
  const k = opener.n;
  const isDel = r === 126;
  if (isDel && k > 2) return -1; // 3+ tildes never form <del>
  // A retry (a run shortened after a failed attempt) sees the character
  // before the original run as its previous character, and always counts
  // as preceded by its own character.
  const retry = opener.retry === true;
  const y = retry ? opener.y : k;
  let nCp = -1;
  if (retry) {
    nCp = opener.p;
  } else if (oi > 0) {
    const prev = items[oi - 1];
    if (typeof prev === 'string') nCp = cpBefore(prev, prev.length);
    else if (prev !== null && typeof prev === 'object' && prev.d !== undefined) nCp = prev.d;
  }
  const tildeWord = r === 42;
  const nc = delimClass(opener.q, true); // GFM: '~' is a word character here
  // The run must be followed by a punctuation or word character.
  if (nc < 2) return -1;
  // '_' cannot open inside a word.
  if (r === 95 && nc === 3 && isAlnumCp(nCp)) return -1;
  // Can it open? A word character after the run always opens; a
  // punctuation character after it opens only when the previous character
  // is absent, whitespace, or punctuation.
  if (nc === 2 && nCp !== -1 && delimClass(nCp, false) === 3) return -1;
  // R: the opener can also close (every closer is then rule-of-3-checked).
  const pcPunct = delimClass(opener.p, false);
  const R = (pcPunct === 2 || pcPunct === 3) && (nc === 2 || (r === 42 && pcPunct === 3));
  const o = retry || nCp === r;
  let m = k;
  let f = 0;
  // The scan skips a lone '*' inside a '__...__' pair (or a lone '_'
  // inside a '**...**' pair) when the pair starts right after the opener:
  // the scan regex consumes that span as plain text, so the delimiter
  // inside it is never counted. Only the first such span counts.
  let skipIdx = -1;
  if (!isDel) {
    const pair = r === 42 ? 95 : 42;
    let j = oi + 1;
    const advance = () => {
      while (j < items.length) {
        const it = items[j];
        if (it !== null && typeof it === 'object' && it.d !== undefined && (it.d === 42 || it.d === 95)) return true;
        if (it !== null && typeof it === 'object' && it.g !== undefined && (it.t.indexOf('*') !== -1 || it.t.indexOf('_') !== -1)) return false;
        j++;
      }
      return false;
    };
    if (advance()) {
      const open = items[j];
      if (open.d === pair && open.n === 2) {
        j++;
        if (advance()) {
          const mid = items[j];
          if (mid.d === r && mid.n === 1) {
            const midIdx = j;
            j++;
            if (advance()) {
              const close = items[j];
              if (close.d === pair && close.n === 2) skipIdx = midIdx;
            }
          }
        }
      }
    }
  }
  for (let ci = oi + 1; ci < items.length; ci++) {
    if (ci === skipIdx) continue;
    const cand = items[ci];
    if (cand === null || typeof cand !== 'object' || cand.d !== r) continue;
    const b = cand.n;
    if (isDel && b !== k) continue; // del only matches equal-length runs
    const cpc = delimClass(cand.p, tildeWord);
    const cnc = delimClass(cand.q, tildeWord);
    // Opener (groups 3/4), both (groups 5/6; '_' has no group 6),
    // closer (groups 1/2), or invisible.
    const gOpener = ((cpc === 1 || cpc === 2) && cnc === 3) || (cpc === 1 && cnc === 2);
    if (gOpener) {
      m += b;
      continue;
    }
    const gBoth = (cpc === 2 && cnc === 2) || (r !== 95 && cpc === 3 && cnc === 3);
    const gCloser = (cpc === 2 && cnc <= 1) || (cpc === 3 && cnc <= 2);
    if (!gBoth && !gCloser) continue; // invisible
    if (isDel) {
      m -= b;
      if (m > 0) continue;
      const inner = [];
      for (let j = oi + 1; j < ci; j++) inner.push(items[j]);
      resolveEmphasis(inner);
      items.splice(oi, ci - oi + 1, { x: 1, k: inner });
      return oi + 1;
    }
    if (gBoth || R) {
      if (o && gBoth) return -1; // the opener's own run blocks the match
      if (y % 3 !== 0 && (y + b) % 3 === 0) {
        f += b;
        continue;
      }
    }
    m -= b;
    if (m > 0) continue;
    const b2 = Math.min(b, b + m + f);
    const use = Math.min(k, b2) % 2 === 1 ? 1 : 2;
    const inner = [];
    if (k - use > 0) inner.push({ d: r, n: k - use, p: -1, q: opener.q });
    for (let j = oi + 1; j < ci; j++) inner.push(items[j]);
    if (b2 - use > 0) inner.push({ d: r, n: b2 - use, p: cand.p, q: -1 });
    resolveEmphasis(inner);
    const node = use === 1 ? { e: 1, k: inner } : { s: 1, k: inner };
    const rep = [node];
    if (b - b2 > 0) rep.push({ d: r, n: b - b2, p: r, q: cand.q });
    items.splice(oi, ci - oi + 1, ...rep);
    return oi + 1;
  }
  return -1;
}

// Resolve emphasis in an item list, left to right: each delimiter run is
// tried as an opener in turn, and a match re-resolves its inner items.
function resolveEmphasis(items) {
  // Link and image labels are tokenized on their own: resolve them first.
  for (const it of items) {
    if (it !== null && typeof it === 'object' && (it.l !== undefined || it.i !== undefined)) resolveEmphasis(it.k);
  }
  // A delimiter at either end of this list has no neighbour on that side
  // (the list is re-tokenized from scratch).
  if (items.length > 0) {
    const first = items[0];
    if (first !== null && typeof first === 'object' && first.d !== undefined) first.p = -1;
    const last = items[items.length - 1];
    if (last !== null && typeof last === 'object' && last.d !== undefined) last.q = -1;
  }
  let di = 0;
  while (di < items.length) {
    const it = items[di];
    if (it === null || typeof it !== 'object' || it.d === undefined || it.done) {
      di++;
      continue;
    }
    const after = tryMatchDelim(items, di);
    if (after === -1) {
      if (it.n > 1) {
        // A failed run is retried from its second character (the first
        // becomes literal text), with the original length kept for the
        // rule of 3.
        const rest = {
          d: it.d,
          n: it.n - 1,
          p: it.p,
          q: it.q,
          y: it.y !== undefined ? it.y : it.n,
          retry: true,
        };
        items.splice(di, 1, String.fromCodePoint(it.d), rest);
        di++; // move to the shortened run
      } else {
        it.done = true;
        di++;
      }
    } else {
      di = after;
    }
  }
}

// Full inline parse: scan, then resolve emphasis.
function parseInline(src, refs) {
  const items = scanInline(src, refs);
  resolveEmphasis(items);
  return items;
}

/* ------------------------------------------------------------------ */
/* Inline rendering                                                    */
/* ------------------------------------------------------------------ */

function renderInline(items, out, inLink) {
  for (const it of items) {
    if (typeof it === 'string') {
      out.push(escText(it));
      continue;
    }
    if (it.d !== undefined) {
      out.push((it.d === 42 ? '*' : it.d === 95 ? '_' : '~').repeat(it.n));
      continue;
    }
    if (it.v !== undefined) {
      out.push(escText(it.v));
      continue;
    }
    if (it.c !== undefined) {
      out.push('<code>', escAll(it.c), '</code>');
      continue;
    }
    if (it.h !== undefined) {
      out.push(it.h);
      continue;
    }
    if (it.b !== undefined) {
      out.push('<br>');
      continue;
    }
    if (it.a !== undefined) {
      out.push('<a href="', escText(it.a), '">', escText(it.t), '</a>');
      continue;
    }
    if (it.g !== undefined) {
      if (inLink) out.push(escText(it.t));
      else out.push('<a href="', escText(it.g), '">', escText(it.t), '</a>');
      continue;
    }
    if (it.l !== undefined) {
      if (it.l === null) {
        renderInline(it.k, out, true);
        continue;
      }
      out.push('<a href="', escText(it.l), '"');
      if (it.ti !== null) out.push(' title="', escText(it.ti), '"');
      out.push('>');
      renderInline(it.k, out, true);
      out.push('</a>');
      continue;
    }
    if (it.i !== undefined) {
      if (it.i === null) {
        plainText(it.k, out);
        continue;
      }
      const alt = [];
      plainText(it.k, alt);
      out.push('<img src="', escText(it.i), '" alt="', alt.join(''), '"');
      if (it.ti !== null) out.push(' title="', escText(it.ti), '"');
      out.push('>');
      continue;
    }
    if (it.e !== undefined) {
      out.push('<em>');
      renderInline(it.k, out, inLink);
      out.push('</em>');
      continue;
    }
    if (it.s !== undefined) {
      out.push('<strong>');
      renderInline(it.k, out, inLink);
      out.push('</strong>');
      continue;
    }
    if (it.x !== undefined) {
      out.push('<del>');
      renderInline(it.k, out, inLink);
      out.push('</del>');
      continue;
    }
  }
}

// Plain-text rendering for image alt text: no tags, text only.
function plainText(items, out) {
  for (const it of items) {
    if (typeof it === 'string') {
      out.push(escText(it));
      continue;
    }
    if (it.d !== undefined) {
      out.push((it.d === 42 ? '*' : it.d === 95 ? '_' : '~').repeat(it.n));
      continue;
    }
    if (it.v !== undefined) {
      out.push(escText(it.v));
      continue;
    }
    if (it.c !== undefined) {
      out.push(escAll(it.c));
      continue;
    }
    if (it.h !== undefined) {
      // HTML in alt text is escaped, not stripped.
      out.push(escText(it.h));
      continue;
    }
    if (it.b !== undefined) continue;
    if (it.a !== undefined || it.g !== undefined) {
      out.push(escText(it.t));
      continue;
    }
    if (it.l !== undefined || it.i !== undefined || it.e !== undefined || it.s !== undefined || it.x !== undefined) {
      plainText(it.k, out);
      continue;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Block parsing                                                       */
/* ------------------------------------------------------------------ */

// HTML block tags (CommonMark list) for type-6 blocks.
const BLOCK_TAGS = new Set(
  ('address article aside base basefont blockquote body caption center col colgroup dd ' +
   'details dialog dir div dl dt fieldset figcaption figure footer form frame frameset ' +
   'h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta ' +
   'nav noframes ol optgroup option p param search section summary table tbody td tfoot ' +
   'th thead title tr track ul').split(' ')
);
const TYPE1_TAGS = new Set(['pre', 'script', 'style', 'textarea']);

// Detect an HTML block start at the beginning of `s` (a line's content after
// container markers). Returns { t, tag } with t = the block type (1-7, 0 = none)
// and tag = the type-1 tag name (pre/script/style/textarea) or null.
// `inPara` selects the stricter type-6 rule marked uses while a paragraph is open
// (a space, not a tab, must follow the tag name).
function htmlBlockStart(s, inPara) {
  let i = 0;
  let indent = 0;
  while (i < s.length && indent < 4) {
    const c = s.charCodeAt(i);
    if (c === 32) { indent++; i++; }
    else if (c === 9) { indent += 4 - (indent % 4); i++; }
    else break;
  }
  if (indent > 3) return { t: 0, tag: null };
  if (s.charCodeAt(i) !== 60) return { t: 0, tag: null }; // <
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 33) { // <!
    if (s.charCodeAt(i + 2) === 45 && s.charCodeAt(i + 3) === 45) return { t: 2, tag: null }; // <!--
    if (s.slice(i + 2, i + 9) === '[CDATA[') return { t: 5, tag: null };
    if (isAlpha(s.charCodeAt(i + 2))) return { t: 4, tag: null };
    return { t: 0, tag: null };
  }
  if (c1 === 63) return { t: 3, tag: null }; // <?
  let j = i + 1;
  let closing = false;
  if (s.charCodeAt(j) === 47) { closing = true; j++; }
  if (!isAlpha(s.charCodeAt(j))) return { t: 0, tag: null };
  let k = j;
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (isAlpha(c) || isDigit(c) || c === 45) k++;
    else break;
  }
  const name = s.slice(j, k).toLowerCase();
  const atEol = k >= s.length;
  const after = s.charCodeAt(k);
  if (!closing && TYPE1_TAGS.has(name)) {
    if (atEol || after === 32 || after === 9 || after === 62) return { t: 1, tag: name };
    return { t: 0, tag: null };
  }
  if (BLOCK_TAGS.has(name)) {
    if (atEol) return { t: 6, tag: null };
    if (after === 62) return { t: 6, tag: null }; // >
    if (after === 47 && s.charCodeAt(k + 1) === 62) return { t: 6, tag: null }; // />
    if (inPara) {
      if (after === 32) return { t: 6, tag: null };
    } else {
      if (after === 32 || after === 9) return { t: 6, tag: null };
    }
    return { t: 0, tag: null };
  }
  // Type 7: a complete open/close tag alone on the line.
  const tagEnd = matchHtmlTag(s, i);
  if (tagEnd !== -1) {
    let m = tagEnd;
    while (m < s.length && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9)) m++;
    if (m >= s.length) return { t: 7, tag: null };
  }
  return { t: 0, tag: null };
}

// Does `line` contain the end marker for an HTML block of the given type?
// Type 1 needs its own closing tag (case-insensitive); the others are fixed strings.
function htmlEndsType1(line, tag) {
  let i = 0;
  while (i < line.length) {
    const lt = line.indexOf('<', i);
    if (lt === -1) return false;
    if (line.charCodeAt(lt + 1) === 47) {
      let k = lt + 2;
      let ok = true;
      for (let q = 0; q < tag.length; q++) {
        if ((line.charCodeAt(k + q) | 32) !== tag.charCodeAt(q)) { ok = false; break; }
      }
      if (ok) {
        let m = k + tag.length;
        while (m < line.length && (line.charCodeAt(m) === 32 || line.charCodeAt(m) === 9)) m++;
        if (line.charCodeAt(m) === 62) return true;
      }
    }
    i = lt + 1;
  }
  return false;
}

function htmlBlockEnds(line, type, tag) {
  if (type === 1) return htmlEndsType1(line, tag);
  if (type === 2) return line.indexOf('-->') !== -1;
  if (type === 3) return line.indexOf('?>') !== -1;
  if (type === 4) return line.indexOf('>') !== -1;
  if (type === 5) return line.indexOf(']]>') !== -1;
  return false;
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

// Split a table row line into cells (marked's cell splitter): split on pipes
// that are not escaped by an odd number of backslashes, drop an empty first
// and last cell, pad/truncate to `count` when given, trim, unescape \|.
function splitCells(line, count) {
  const cells = [];
  let start = 0;
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (line.charCodeAt(i) === 124) { // |
      let bs = 0;
      let k = i - 1;
      while (k >= start && line.charCodeAt(k) === 92) { bs++; k--; }
      if (bs % 2 === 0) {
        cells.push(line.slice(start, i));
        start = i + 1;
      }
    }
    i++;
  }
  cells.push(line.slice(start));
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let k = 0; k < cells.length; k++) {
    cells[k] = cells[k].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// Parse a table delimiter row. Returns the alignment array ('left'/'center'/
// 'right'/null per cell) or null if the line is not a delimiter row.
function parseDelimiter(line) {
  let i = 0;
  let indent = 0;
  while (i < line.length && indent < 4) {
    const c = line.charCodeAt(i);
    if (c === 32) { indent++; i++; }
    else if (c === 9) { indent += 4 - (indent % 4); i++; }
    else break;
  }
  if (indent > 3) return null;
  if (line.indexOf(':', i) === -1 && line.indexOf('|', i) === -1) return null;
  const aligns = [];
  let j = i;
  const n = line.length;
  if (line.charCodeAt(j) === 124) j++; // optional leading |
  for (;;) {
    while (j < n && line.charCodeAt(j) === 32) j++;
    const left = line.charCodeAt(j) === 58;
    if (left) j++;
    let dashes = 0;
    while (j < n && line.charCodeAt(j) === 45) { j++; dashes++; }
    if (dashes === 0) return null;
    const right = line.charCodeAt(j) === 58;
    if (right) j++;
    while (j < n && line.charCodeAt(j) === 32) j++;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
    if (j >= n) break;
    if (line.charCodeAt(j) !== 124) return null;
    j++;
    if (j >= n) break;
    let k = j;
    while (k < n && line.charCodeAt(k) === 32) k++;
    if (k >= n) break; // trailing | + spaces
  }
  return aligns;
}

/* ------------------------------------------------------------------ */
/* Link reference definitions                                          */
/* ------------------------------------------------------------------ */

// Parse one link reference definition at `text[start..]` (a paragraph's text
// from that offset). Returns { label, href, title, next } — next is the offset
// after the definition, including its trailing newlines — or null.
function tryParseDef(text, start) {
  let i = start;
  let sp = 0;
  while (sp < 3 && text.charCodeAt(i) === 32) { i++; sp++; }
  if (text.charCodeAt(i) !== 91) return null; // [
  let j = i + 1;
  let label = '';
  let labelHasNonSpace = false;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === 93) break; // ]
    if (c === 91) return null; // unescaped [
    if (c === 92 && j + 1 < text.length) {
      // Keep the backslash: labels match in their raw (escaped) form.
      label += text[j] + text[j + 1];
      labelHasNonSpace = true; // an escape is never "whitespace" for the lookahead
      j += 2;
      continue;
    }
    if (c === 10) {
      // A newline is allowed only if the next line is not blank.
      let k = j + 1;
      while (k < text.length && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
      if (k >= text.length || text.charCodeAt(k) === 10) return null;
      label += '\n';
      j++;
      continue;
    }
    label += text[j];
    if (c !== 32 && c !== 9) labelHasNonSpace = true;
    j++;
  }
  if (j >= text.length || text.charCodeAt(j) !== 93) return null; // no ]
  if (!labelHasNonSpace) return null; // empty / whitespace-only label
  if (text.charCodeAt(j + 1) !== 58) return null; // needs :
  j += 2;
  while (text.charCodeAt(j) === 32) j++;
  if (text.charCodeAt(j) === 10) {
    j++;
    while (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9) j++;
  }
  // Destination: <...> or a bare non-space run (parens must balance).
  let href;
  if (text.charCodeAt(j) === 60) { // <
    let k = j + 1;
    let out = '';
    let ok = false;
    while (k < text.length) {
      const c = text.charCodeAt(k);
      if (c === 62) { ok = true; k++; break; } // >
      if (c === 10) return null; // no line ending in an angle dest
      if (c === 92 && k + 1 < text.length && ASCII_PUNCT[text.charCodeAt(k + 1)] === 1) {
        out += text[k + 1];
        k += 2;
      } else {
        out += text[k];
        k++;
      }
    }
    if (!ok) return null;
    href = out;
    j = k;
  } else {
    let k = j;
    let out = '';
    let depth = 0;
    let unbalanced = false;
    while (k < text.length) {
      const c = text.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92 && k + 1 < text.length && ASCII_PUNCT[text.charCodeAt(k + 1)] === 1) {
        out += text[k + 1];
        k += 2;
        continue;
      }
      if (c === 40) depth++;
      else if (c === 41) {
        depth--;
        if (depth < 0) unbalanced = true;
      }
      out += text[k];
      k++;
    }
    if (out === '' || depth !== 0 || unbalanced) return null;
    href = out;
    j = k;
  }
  // Optional title, after a separator of spaces and/or one newline.
  let title = null;
  const saveJ = j;
  let t = j;
  let sawSep = false;
  while (text.charCodeAt(t) === 32) { t++; sawSep = true; }
  if (text.charCodeAt(t) === 10) {
    t++;
    while (text.charCodeAt(t) === 32 || text.charCodeAt(t) === 9) t++;
    sawSep = true;
  }
  if (sawSep) {
    const ti = parseLinkTitle(text, t);
    if (ti !== null) {
      title = ti.title;
      j = ti.next;
    }
  }
  // Trailing spaces, then newlines or end of text.
  while (text.charCodeAt(j) === 32) j++;
  if (j >= text.length) return { label, href, title, next: j };
  if (text.charCodeAt(j) === 10) {
    let k = j;
    while (text.charCodeAt(k) === 10) k++;
    return { label, href, title, next: k };
  }
  // The title did not work out (junk after it): retry without the title,
  // as marked's regex backtracks to the title-less form.
  if (title !== null) {
    j = saveJ;
    while (text.charCodeAt(j) === 32) j++;
    if (j >= text.length) return { label, href, title: null, next: j };
    if (text.charCodeAt(j) === 10) {
      let k = j;
      while (text.charCodeAt(k) === 10) k++;
      return { label, href, title: null, next: k };
    }
  }
  return null;
}

// Pull leading link reference definitions out of a paragraph's text.
// Registers them in `refs` (first definition wins) and returns the offset
// where the remaining paragraph text starts.
function extractDefs(text, refs) {
  let off = 0;
  for (;;) {
    const d = tryParseDef(text, off);
    if (d === null) return off;
    const key = normalizeLabel(d.label);
    if (!refs.has(key)) refs.set(key, { href: d.href, title: d.title });
    off = d.next;
  }
}

/* ------------------------------------------------------------------ */
/* Line cursor (tab-aware)                                             */
/* ------------------------------------------------------------------ */

// A cursor into one source line: s = the line, i = the char index, col = the
// visual column, tab = the columns left of a partially consumed tab.
function makeCursor() {
  return { s: '', i: 0, col: 0, tab: 0 };
}

function curChar(cur) {
  if (cur.tab > 0) return 32;
  return cur.i < cur.s.length ? cur.s.charCodeAt(cur.i) : -1;
}

// Advance one column (the current char must be a space or tab). A tab is
// only partly consumed: its remaining columns stay in cur.tab.
function curAdvance1(cur) {
  if (cur.tab > 0) {
    cur.tab--;
    cur.col++;
    if (cur.tab === 0) cur.i++;
  } else if (cur.i < cur.s.length && cur.s.charCodeAt(cur.i) === 9) {
    const w = 4 - (cur.col % 4);
    cur.tab = w - 1;
    cur.col++;
  } else {
    cur.i++;
    cur.col++;
  }
}

// Advance n columns through spaces/tabs. False when blocked by other text.
function curAdvanceCols(cur, n) {
  while (n > 0) {
    if (cur.tab > 0) {
      const take = n < cur.tab ? n : cur.tab;
      cur.tab -= take;
      cur.col += take;
      n -= take;
      if (cur.tab === 0) cur.i++;
      continue;
    }
    if (cur.i >= cur.s.length) return false;
    const c = cur.s.charCodeAt(cur.i);
    if (c === 32) { cur.i++; cur.col++; n--; }
    else if (c === 9) {
      const w = 4 - (cur.col % 4);
      if (w > n) { cur.tab = w - n; cur.col += n; n = 0; }
      else { cur.i++; cur.col += w; n -= w; }
    } else return false;
  }
  return true;
}

function curRestBlank(cur) {
  let j = cur.tab > 0 ? cur.i + 1 : cur.i;
  for (; j < cur.s.length; j++) {
    const c = cur.s.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function curRest(cur) {
  if (cur.tab > 0) return ' '.repeat(cur.tab) + cur.s.slice(cur.i + 1);
  return cur.s.slice(cur.i);
}

// Peek: skip spaces/tabs from the cursor without moving it. Fills `out`
// { indent, i, col, tab, ch }: the indent in columns, the position after the
// whitespace, and the first non-space char (-1 at end of line).
function curPeek(cur, out) {
  let i = cur.i;
  let col = cur.col;
  let tab = cur.tab;
  let indent = 0;
  for (;;) {
    if (tab > 0) { indent += tab; col += tab; tab = 0; i++; continue; }
    if (i >= cur.s.length) {
      out.indent = indent; out.i = i; out.col = col; out.tab = 0; out.ch = -1;
      return;
    }
    const c = cur.s.charCodeAt(i);
    if (c === 32) { i++; col++; indent++; }
    else if (c === 9) { const w = 4 - (col % 4); i++; col += w; indent += w; }
    else {
      out.indent = indent; out.i = i; out.col = col; out.tab = 0; out.ch = c;
      return;
    }
  }
}

// Expand tabs in the LEADING whitespace of `s`, assuming it starts at
// column `col0`. Mid-line tabs are kept as-is (marked's container
// tokenizers expand the indent region only).
function expandLeadingTabs(s, col0) {
  let out = '';
  let col = col0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { out += ' '; i++; col++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      i++;
      col += w;
    } else break;
  }
  if (i === 0) return s;
  return out + s.slice(i);
}

// Expand tabs in `s`, assuming it starts at column `col0`.
function expandTabs(s, col0) {
  if (s.indexOf('\t') === -1) return s;
  let out = '';
  let col = col0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += s[i];
      col++;
    }
  }
  return out;
}

// Strip up to `n` columns from the start of `s` (tab-aware, from column `col0`).
function stripCols(s, n, col0) {
  let col = col0;
  let i = 0;
  while (i < s.length && col - col0 < n) {
    const c = s.charCodeAt(i);
    if (c === 32) { i++; col++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col - col0 + w > n) return ' '.repeat(col - col0 + w - n) + s.slice(i + 1);
      i++;
      col += w;
    } else break;
  }
  return s.slice(i);
}

// Count the leading indent of `s` in columns (tab-aware, from column `col0`).
function leadingIndent(s, col0) {
  let col = col0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { i++; col++; }
    else if (c === 9) { const w = 4 - (col % 4); i++; col += w; }
    else break;
  }
  return col - col0;
}

/* ------------------------------------------------------------------ */
/* The block parser                                                    */
/*                                                                     */
/* Node types:                                                         */
/*   doc    { t:'doc', children }                                      */
/*   quote  { t:'q', children, prevLazy }                              */
/*   list   { t:'list', ordered, bullet, start, loose, sawBlank, children } */
/*   item   { t:'item', relCol, empty, children }  (relCol = content indent, relative to the outer containers' end) */
/*   para   { t:'p', lines, prevM, text }                              */
/*   head   { t:'h', level, text }                                     */
/*   hr     { t:'hr' }                                                 */
/*   fence  { t:'fence', ch, len, lang, lines, fenceIndent, closed }   */
/*   code   { t:'code', lines }   (indented code)                      */
/*   html   { t:'html', type, tag, lines, ended }                      */
/*   table  { t:'table', aligns, header, rows }                        */
/* ------------------------------------------------------------------ */

function parseBlocks(lines, srcEndsNL) {
  const refs = new Map();
  const root = { t: 'doc', children: [] };
  const stack = [root];
  let openLeaf = null; // { parent, idx, node, depth }
  const cur = makeCursor();
  const peek = { indent: 0, i: 0, col: 0, tab: 0, ch: -1 };
  // The innermost matching quote's prevLazy value before this line
  // (captured during container matching; used by appendPara).
  let qPrevLazy = false;
  // The marker-line prevM, used by startParagraph when the paragraph is the
  // first block of a list item started on this line.
  let pendingItemPrevM = null;

  const innermost = () => stack[stack.length - 1];

  // The paragraph's text after its leading definitions are pulled out
  // (definitions are registered as a side effect; calling this twice is safe).
  function paraRemaining(node) {
    const text = node.lines.join('\n');
    const off = extractDefs(text, refs);
    return text.slice(off);
  }

  function closeLeaf() {
    if (!openLeaf) return;
    const { parent, idx, node } = openLeaf;
    if (node.t === 'p') {
      const rest = paraRemaining(node);
      if (rest === '') {
        parent.children.splice(idx, 1);
      } else {
        node.text = rest;
        delete node.lines;
        delete node.prevM;
      }
    } else if (node.t === 'code') {
      // Trim trailing blank lines (empty or all-whitespace).
      let end = node.lines.length;
      while (end > 0) {
        const ln = node.lines[end - 1];
        let allWS = true;
        for (let k = 0; k < ln.length; k++) {
          const c = ln.charCodeAt(k);
          if (c !== 32 && c !== 9) { allWS = false; break; }
        }
        if (!allWS) break;
        end--;
      }
      node.lines.length = end;
    } else if (node.t === 'html') {
      // The trailing-newline rule: the block's text ends with \n when the
      // next line in the same container is not blank. At EOF, that is the
      // input's own trailing newline — but only at the top level (inside a
      // container, the container's text ends at the block).
      if (node.trailNL === undefined) {
        node.trailNL = parent.t === 'doc' ? srcEndsNL : false;
      }
    }
    openLeaf = null;
  }

  function popTo(depth) {
    closeLeaf();
    while (stack.length > depth) stack.pop();
  }

  function addLeaf(node, keepOpen) {
    const parent = innermost();
    const idx = parent.children.length;
    parent.children.push(node);
    // Any block starting in an item makes it non-empty (so a later blank
    // line does not close it).
    if (parent.t === 'item') parent.empty = false;
    if (keepOpen) openLeaf = { parent, idx, node, depth: stack.length };
    else openLeaf = null;
  }

  function clearSawBlank() {
    for (const fr of stack) if (fr.t === 'list') fr.sawBlank = false;
  }

  // A blank line intervened. It marks lists as "saw blank" (the deferred
  // looseness check decides which one actually becomes loose), but only
  // the lists the blank line is directly between the blocks of: a blank
  // line inside a quote does not affect lists outside that quote (the
  // blank line is inside the quote block, not between the item's blocks),
  // and a blank line absorbed as fence/code/HTML content is not a
  // separator at all (callers skip the call in that case).
  function markSawBlankAt(matched) {
    let deepestQuote = -1;
    for (let fi = 1; fi < matched; fi++) {
      if (stack[fi].t === 'q') deepestQuote = fi;
    }
    if (deepestQuote === -1) {
      for (const fr of stack) if (fr.t === 'list') fr.sawBlank = true;
    } else {
      for (let fi = deepestQuote + 1; fi < stack.length; fi++) {
        if (stack[fi].t === 'list') stack[fi].sawBlank = true;
      }
    }
  }

  // A new block is starting: if a blank line intervened since the last
  // content, the list that directly owns the block's container (when the
  // block is a direct child of a list item) becomes loose. A block inside
  // a nested quote does not loosen the outer list — the blank line was
  // inside the quote block, not between the item's blocks.
  function blankBeforeBlock() {
    const parent = innermost();
    if (parent.t === 'item') {
      const list = stack[stack.length - 2];
      if (list !== undefined && list.t === 'list' && list.sawBlank) list.loose = true;
    }
    clearSawBlank();
  }

  // Is `s` a setext underline line (up to 3 spaces, a run of = or -, then
  // only spaces/tabs)? Returns 1 for =, 2 for -, 0 for no.
  function setextLevel(s) {
    let i = 0;
    let sp = 0;
    while (sp < 3 && s.charCodeAt(i) === 32) { i++; sp++; }
    const c = s.charCodeAt(i);
    if (c !== 61 && c !== 45) return 0; // = or -
    let j = i;
    while (s.charCodeAt(j) === c) j++;
    if (j === i) return 0;
    while (j < s.length) {
      const t = s.charCodeAt(j);
      if (t !== 32 && t !== 9) return 0;
      j++;
    }
    return c === 61 ? 1 : 2;
  }

  // Is `s` a setext line for the list lazy rule (trailing spaces only, no tabs)?
  function setextLevelList(s) {
    let i = 0;
    let sp = 0;
    while (sp < 3 && s.charCodeAt(i) === 32) { i++; sp++; }
    const c = s.charCodeAt(i);
    if (c !== 61 && c !== 45) return 0;
    let j = i;
    while (s.charCodeAt(j) === c) j++;
    if (j === i) return 0;
    while (j < s.length) {
      if (s.charCodeAt(j) !== 32) return 0;
      j++;
    }
    return c === 61 ? 1 : 2;
  }

  // The lheading test for the list lazy rule: marked tests its lheading regex
  // on m + '\n' + the setext line. The regex's text part needs at least one
  // character, and every other failure mode (m starting with a block start
  // or with 4 spaces) is already excluded by the lazy branch's break
  // conditions — so the test reduces to "m is non-empty".
  function lheadingTest(m) {
    return m.length > 0;
  }

  // After a '>' has been consumed, expand the whitespace run that follows
  // it with tab stops counted from the marker's width in the stripped text
  // (the spaces skipped before it plus the marker itself), consume one
  // column of it with the marker, and rebase the cursor to column 0 of the
  // stripped text. `skipped` is the number of columns before the marker.
  // The cursor must be right after '>' with cur.tab === 0.
  function consumeQuoteSpace(skipped) {
    const base = skipped + 1;
    let j = cur.i;
    let col = base;
    let width = 0;
    let hasTab = false;
    while (j < cur.s.length) {
      const c = cur.s.charCodeAt(j);
      if (c === 32) { width++; col++; j++; }
      else if (c === 9) { const w = 4 - (col % 4); width += w; col += w; j++; hasTab = true; }
      else break;
    }
    if (hasTab && width > 0) {
      const remain = width - 1;
      if (remain > 0) {
        cur.i = j - 1; // last whitespace char; curRest expands cur.tab after it
        cur.tab = remain;
      } else {
        cur.i = j;
        cur.tab = 0;
      }
    } else if (width > 0) {
      cur.i++;
    }
    cur.col = 0;
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    cur.s = line;
    cur.i = 0;
    cur.col = 0;
    cur.tab = 0;

    // ---- Phase 1: match the open containers. ----
    // `matched` = the index of the first frame the line does not match
    // (stack.length when all match). `preItem` = the cursor state before
    // the innermost item's content indent was consumed (for the lazy-setext
    // m value), or null when no item frame was reached.
    let matched = stack.length;
    let preItem = null;
    qPrevLazy = false;
    for (let fi = 1; fi < stack.length; fi++) {
      const fr = stack[fi];
      if (fr.t === 'list') continue; // lists consume nothing
      if (fr.t === 'q') {
        const saveI = cur.i;
        const saveCol = cur.col;
        const saveTab = cur.tab;
        let ok = false;
        // Skip up to 3 spaces, then '>'.
        let skipped = 0;
        while (skipped < 3 && curChar(cur) === 32) { curAdvance1(cur); skipped++; }
        if (curChar(cur) === 62) { // >
          curAdvance1(cur);
          // The whitespace after the marker is tab-expanded with tab stops
          // counted from the marker's width in the stripped text, then one
          // column of it is consumed with the marker. Expanding from the
          // original column instead double-counts in nested quotes.
          if (cur.tab === 0) {
            consumeQuoteSpace(skipped);
          } else {
            // A partially consumed tab from an outer level: one column, as before.
            if (curChar(cur) === 32 || curChar(cur) === 9) curAdvance1(cur);
          }
          ok = true;
        }
        if (ok) {
          qPrevLazy = fr.prevLazy;
          fr.prevLazy = false;
        } else {
          cur.i = saveI;
          cur.col = saveCol;
          cur.tab = saveTab;
          matched = fi;
          break;
        }
      } else if (fr.t === 'item') {
        preItem = { i: cur.i, col: cur.col, tab: cur.tab };
        // The item's content indent is relative to the position after the
        // outer containers (the quote prefix widths vary per line, so an
        // absolute column would mis-match continuations).
        const need = fr.relCol;
        if (need <= 0) {
          // Already at/past the content column.
        } else {
          const saveI = cur.i;
          const saveCol = cur.col;
          const saveTab = cur.tab;
          if (!curAdvanceCols(cur, need)) {
            cur.i = saveI;
            cur.col = saveCol;
            cur.tab = saveTab;
            matched = fi;
            break;
          }
        }
      }
    }

    // ---- Phase 2: blank content (after the matched containers). ----
    if (curRestBlank(cur)) {
      // A trailing spaces-only line in a quote, on the last line of the
      // input, is a paragraph continuation, not a blank line: the quote's
      // inner text has no \n after it, so the paragraph regex keeps it.
      if (
        li === lines.length - 1 &&
        openLeaf !== null &&
        openLeaf.node.t === 'p' &&
        openLeaf.parent.t === 'q' &&
        curRest(cur) !== ''
      ) {
        const content = curRest(cur);
        if (matched >= openLeaf.depth) appendPara(content, preItem);
        else appendLazyPara(content, preItem, matched);
        continue;
      }
      // A blank line ends paragraphs and tables, and type 6/7 HTML blocks.
      // Fences, indented code, and type 1-5 HTML blocks absorb it as content
      // — but only when the blank line is inside their container. For blank
      // lines, "inside" means matching every quote that contains the leaf;
      // list items do not matter (a blank line is part of an item's text
      // regardless of its indent).
      let absorbed = false;
      let insideLeaf = true;
      let deepestQuote = -1;
      if (openLeaf !== null) {
        for (let fi = 1; fi < openLeaf.depth; fi++) {
          if (stack[fi].t === 'q') deepestQuote = fi;
        }
        insideLeaf = matched > deepestQuote;
      }
      if (openLeaf !== null) {
        const node = openLeaf.node;
        if (node.t === 'p' || node.t === 'table') {
          // A blank-looking line that holds a tab is still a table row in
          // marked (its table body only excludes space-only lines): the
          // row is empty cells. A paragraph still ends on it.
          if (node.t === 'table' && insideLeaf && curRest(cur).indexOf('\t') !== -1) {
            node.rows.push(splitCells(curRest(cur), node.aligns.length));
            absorbed = true;
          } else {
            closeLeaf();
          }
        } else if (node.t === 'html') {
          if (node.ended) {
            // The block keeps its trailing \n when the blank line is
            // inside a quote (the quote's inner text joins a \n onto it)
            // or when the blank line itself holds whitespace (a truly
            // empty line swallows the \n via the (\n+) in the html match).
            node.trailNL = insideLeaf && (deepestQuote >= 0 || curRest(cur) !== '');
            closeLeaf();
          } else if (node.type === 6 || node.type === 7) {
            node.trailNL = false;
            closeLeaf();
          } else if (insideLeaf) {
            node.lines.push(curRest(cur));
            absorbed = true;
          } else {
            node.trailNL = false;
            closeLeaf();
          }
        } else if (node.t === 'fence' || node.t === 'code') {
          if (insideLeaf) {
            // Fences keep the blank line's spaces; indented code strips
            // the 4-column indent from it. Inside a container, leading
            // tabs are expanded (relative to the source column).
            if (node.t === 'fence') node.lines.push(node.inContainer ? expandLeadingTabs(curRest(cur), cur.col) : curRest(cur));
            else node.lines.push(stripCols(curRest(cur), 4, cur.col));
            if (node.t === 'fence') node.lastLazy = false;
            absorbed = true;
          } else {
            closeLeaf();
          }
        }
      }
      // A blank line absorbed as content is not a block separator: it
      // does not loosen any list.
      if (!absorbed) markSawBlankAt(matched);
      for (const fr of stack) if (fr.t === 'q') fr.prevLazy = false;
      // A blank line that does not match a quote closes that quote (and
      // everything inside it). Lists survive blank lines.
      let closeFrom = -1;
      for (let fi = matched; fi < stack.length; fi++) {
        if (stack[fi].t === 'q') { closeFrom = fi; break; }
      }
      if (closeFrom !== -1) {
        while (stack.length > closeFrom) stack.pop();
      }
      // An empty item followed by a blank line is closed: it cannot take
      // content after the blank line. The item node stays in the tree
      // (as an empty <li></li>); only the container frame is popped.
      while (stack.length > 1 && stack[stack.length - 1].t === 'item' && stack[stack.length - 1].empty) {
        stack.pop();
      }
      continue;
    }

    // ---- Phase 3: non-blank content. ----
    // (Leaf continuation and block starts are handled below.)
    handleLine(li, line, matched, preItem);
  }

  // ---- EOF: close everything. ----
  closeLeaf();

  return { root, refs };

  // ------------------------------------------------------------------
  // The per-line handler (defined inside parseBlocks so it can use the
  // shared state). `matched`/`preItem` come from Phase 1; the cursor is
  // positioned after the matched containers.
  // ------------------------------------------------------------------
  function handleLine(li, line, matched, preItem) {
    // The open leaf's container depth (for lazy checks).
    const leafDepth = openLeaf !== null ? openLeaf.depth : -1;
    const leafInside = openLeaf !== null && matched >= leafDepth;

    // --- Fence continuation. ---
    if (openLeaf !== null && openLeaf.node.t === 'fence') {
      const f = openLeaf.node;
      if (!leafInside) {
        // A lazy line continues a fence only when the first unmatched
        // container is a list item, the line is not a block start, and
        // the fence's previous line does not end the item (the opening
        // fence line always ends it, so a lazy line right after the
        // opening never becomes content). A lazy line never continues
        // a fence in a quote or at the top level.
        if (matched < stack.length && stack[matched].t === 'item' && !lazyBlockStart() && fenceLazyAllowed(f, stack[matched].relCol)) {
          const content = curRest(cur);
          f.lines.push(f.inContainer ? expandLeadingTabs(content, cur.col) : content);
          f.lastLazy = true;
          return;
        }
        popTo(matched);
      } else {
        // Closing fence? Same char, length >= opening, <=3 indent, spaces only.
        curPeek(cur, peek);
        const content = curRest(cur);
        let isClose = false;
        if (peek.indent <= 3 && peek.ch === f.ch) {
          let k = peek.i;
          let run = 0;
          while (k < line.length && line.charCodeAt(k) === f.ch) { k++; run++; }
          let restBlank = true;
          while (k < line.length) {
            const c = line.charCodeAt(k);
            if (c !== 32 && c !== 9) { restBlank = false; break; }
            k++;
          }
          if (run >= f.len && restBlank) isClose = true;
        }
        if (isClose) {
          f.closed = true;
          closeLeaf();
          return;
        }
        // Inside a container, leading tabs in the content line are
        // expanded (relative to the source column) by the container
        // tokenizer; at the top level they are kept as-is.
        f.lines.push(f.inContainer ? expandLeadingTabs(content, cur.col) : content);
        f.lastLazy = false;
        return;
      }
    }

    // --- Indented code continuation. ---
    if (openLeaf !== null && openLeaf.node.t === 'code') {
      if (!leafInside) {
        popTo(matched);
      } else {
        curPeek(cur, peek);
        if (peek.indent >= 4) {
          // Strip 4 columns from the content.
          const content = curRest(cur);
          openLeaf.node.lines.push(stripCols(content, 4, cur.col));
          return;
        }
        closeLeaf();
        popTo(matched);
      }
    }

    // --- HTML block continuation. ---
    if (openLeaf !== null && openLeaf.node.t === 'html') {
      const h = openLeaf.node;
      if (h.ended) {
        // The block ended on an earlier line; this line follows it in the
        // same container (trailing \n kept) or outside it (dropped).
        h.trailNL = leafInside;
        closeLeaf();
        popTo(matched);
      } else if (!leafInside) {
        // The container ended: the block's text has no trailing \n.
        h.trailNL = false;
        closeLeaf();
        popTo(matched);
      } else {
        const content = curRest(cur);
        h.lines.push(content);
        if (h.type >= 1 && h.type <= 5 && htmlBlockEnds(content, h.type, h.tag)) {
          h.ended = true;
        }
        return;
      }
    }

    // --- Table continuation. ---
    if (openLeaf !== null && openLeaf.node.t === 'table') {
      const t = openLeaf.node;
      if (!leafInside) {
        closeLeaf();
        popTo(matched);
      } else if (!tableRowEndsHere()) {
        const content = curRest(cur);
        t.rows.push(splitCells(content, t.aligns.length));
        return;
      } else {
        closeLeaf();
        // Fall through to block-start processing (the line starts a new block).
      }
    }

    // --- Paragraph: setext / table / interrupt / continuation. ---
    if (openLeaf !== null && openLeaf.node.t === 'p') {
      const para = openLeaf.node;
      const parent = openLeaf.parent;
      const idx = openLeaf.idx;
      const content = curRest(cur);
      const lazy = !leafInside;

      if (!lazy) {
        // The line matches the paragraph's containers: check setext, table,
        // and interrupting block starts.
        const sl = setextLevel(content);
        if (sl !== 0) {
          const rest = paraRemaining(para);
          if (rest === '') {
            // The paragraph was only definitions: it vanishes, and the
            // setext line starts a fresh paragraph.
            closeLeaf();
            startParagraph(content, preItem);
            return;
          }
          const h = { t: 'h', level: sl, text: rest.trim() };
          parent.children[idx] = h;
          openLeaf = null;
          return;
        }
        const aligns = parseDelimiter(content);
        if (aligns !== null) {
          const rest = paraRemaining(para);
          if (rest !== '') {
            const lastNL = rest.lastIndexOf('\n');
            const headerLine = lastNL === -1 ? rest : rest.slice(lastNL + 1);
            const headerCells = splitCells(headerLine);
            if (aligns.length === headerCells.length) {
              const table = { t: 'table', aligns, header: headerCells, rows: [] };
              if (lastNL === -1) {
                parent.children[idx] = table;
                openLeaf = { parent, idx, node: table, depth: stack.length };
              } else {
                // The lines before the header stay a paragraph.
                para.text = rest.slice(0, lastNL);
                delete para.lines;
                delete para.prevM;
                const tidx = parent.children.length;
                parent.children.push(table);
                openLeaf = { parent, idx: tidx, node: table, depth: stack.length };
              }
              return;
            }
          }
          // Not a table (or the paragraph was only defs): the delimiter line
          // is a paragraph continuation — unless the paragraph was only defs,
          // in which case it starts a fresh paragraph.
          if (rest === '') {
            closeLeaf();
            startParagraph(content, preItem);
            return;
          }
        }
        // Interrupting block starts.
        if (interruptsParagraph()) {
          closeLeaf();
          popTo(matched);
          startBlock();
          return;
        }
        // Ordinary continuation.
        appendPara(content, preItem);
        return;
      }

      // Lazy line: it can only continue the paragraph (never a setext/table
      // conversion, never a new block — unless it is a block start, which
      // ends the paragraph instead of continuing it).
      if (lazyBlockStart()) {
        popTo(matched);
        startBlock();
        return;
      }
      // The list lazy break: when the previous line (after the item indent)
      // is indented by 4 or more, a lazy line ends the item instead of
      // continuing it.
      if (openLeaf.parent.t === 'item' && para.prevM !== null && para.prevM !== undefined) {
        let ns = 0;
        while (ns < para.prevM.length && para.prevM.charCodeAt(ns) === 32) ns++;
        if (ns < para.prevM.length && ns >= 4) {
          popTo(matched);
          startBlock();
          return;
        }
      }
      appendLazyPara(content, preItem, matched);
      return;
    }

    // --- No open leaf: the line starts a new block (after popping to the
    // matched depth). ---
    if (openLeaf !== null) closeLeaf();
    if (stack.length > matched) popTo(matched);
    startBlock();
  }

  // Is `s` a thematic break line (up to 3 spaces, 3+ of the same char
  // -, *, or _, with only spaces/tabs between)? Returns the char or 0.
  function isHrLine(s) {
    let i = 0;
    let indent = 0;
    while (i < s.length && indent < 4) {
      const c = s.charCodeAt(i);
      if (c === 32) { indent++; i++; }
      else if (c === 9) { indent += 4 - (indent % 4); i++; }
      else break;
    }
    if (indent > 3) return 0;
    const c = s.charCodeAt(i);
    if (c !== 45 && c !== 42 && c !== 95) return 0;
    let count = 0;
    let j = i;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      if (d === c) { count++; j++; }
      else if (d === 32 || d === 9) j++;
      else return 0;
    }
    return count >= 3 ? c : 0;
  }

  // Is there a list marker at the start of `s` (content after containers,
  // starting at absolute column `baseCol`)? Returns { ordered, start } or
  // null. Used only as a check (it does not move the cursor); the real
  // parse is parseListMarker below.
  function listMarkerAt(s, baseCol) {
    let i = 0;
    let indent = 0;
    while (i < s.length && indent < 4) {
      const c = s.charCodeAt(i);
      if (c === 32) { indent++; i++; }
      else if (c === 9) { indent += 4 - ((baseCol + indent) % 4); i++; }
      else break;
    }
    if (indent > 3) return null;
    const c = s.charCodeAt(i);
    let ordered = false;
    let start = 0;
    let markerEnd = 0;
    if (c === 45 || c === 43 || c === 42) { // - + *
      markerEnd = i + 1;
    } else if (isDigit(c)) {
      let j = i;
      let num = 0;
      let digits = 0;
      while (j < s.length && isDigit(s.charCodeAt(j)) && digits < 10) {
        num = num * 10 + (s.charCodeAt(j) - 48);
        j++;
        digits++;
      }
      if (digits > 9) return null;
      const d = s.charCodeAt(j);
      if (d !== 46 && d !== 41) return null; // . or )
      ordered = true;
      start = num;
      markerEnd = j + 1;
    } else {
      return null;
    }
    // After the marker: spaces/tabs then content, or end of line (empty item).
    let k = markerEnd;
    let spaces = 0;
    while (k < s.length) {
      const c2 = s.charCodeAt(k);
      if (c2 === 32 || c2 === 9) { k++; spaces++; }
      else break;
    }
    if (k >= s.length) return { ordered, start, empty: true }; // empty item
    if (spaces === 0) return null;
    return { ordered, start, empty: false };
  }

  // Parse a list marker at the cursor. On success, advances the cursor to
  // the item content and returns
  // { ordered, bullet, start, contentCol, empty, markerEndIdx, markerCol, startCol }
  // (startCol is the column where the content started, before the marker).
  // On failure, leaves the cursor unchanged and returns null.
  function parseListMarker() {
    const saveI = cur.i;
    const saveCol = cur.col;
    const saveTab = cur.tab;
    curPeek(cur, peek);
    if (peek.indent > 3) return null;
    const s = cur.s;
    const ch = peek.ch;
    let ordered = false;
    let bullet = '';
    let start = 0;
    let markerLen = 0;
    let k = peek.i;
    if (ch === 45 || ch === 43 || ch === 42) {
      bullet = s[k];
      markerLen = 1;
      k++;
    } else if (isDigit(ch)) {
      let num = 0;
      let digits = 0;
      while (k < s.length && isDigit(s.charCodeAt(k)) && digits < 10) {
        num = num * 10 + (s.charCodeAt(k) - 48);
        k++;
        digits++;
      }
      if (digits > 9 || digits === 0) return null;
      const d = s.charCodeAt(k);
      if (d !== 46 && d !== 41) return null;
      ordered = true;
      bullet = s[k];
      start = num;
      markerLen = digits + 1;
      k++;
    } else {
      return null;
    }
    cur.i = k;
    cur.col = peek.col + markerLen;
    cur.tab = 0;
    const markerCol = cur.col;
    const markerEndIdx = k;
    let spaces = 0;
    while (cur.i < s.length) {
      const c = s.charCodeAt(cur.i);
      if (c === 32) { cur.i++; cur.col++; spaces++; }
      else if (c === 9) {
        const w = 4 - (cur.col % 4);
        cur.i++;
        cur.col += w;
        spaces += w;
      } else break;
    }
    if (cur.i >= s.length) {
      return { ordered, bullet, start, contentCol: markerCol + 1, empty: true, markerEndIdx, markerCol, startCol: saveCol };
    }
    if (spaces === 0) {
      cur.i = saveI;
      cur.col = saveCol;
      cur.tab = saveTab;
      return null;
    }
    if (spaces > 4) {
      // More than 4 spaces: the content indent is the marker + 1 column.
      cur.i = markerEndIdx;
      cur.col = markerCol;
      cur.tab = 0;
      curAdvance1(cur);
      return { ordered, bullet, start, contentCol: markerCol + 1, empty: false, markerEndIdx, markerCol, startCol: saveCol };
    }
    return { ordered, bullet, start, contentCol: cur.col, empty: false, markerEndIdx, markerCol, startCol: saveCol };
  }

  // Is the current line (at the cursor) an ATX heading start?
  function atxAtCursor() {
    curPeek(cur, peek);
    if (peek.indent > 3) return 0;
    const s = cur.s;
    let k = peek.i;
    let n = 0;
    while (k < s.length && s.charCodeAt(k) === 35 && n < 7) { k++; n++; }
    if (n < 1 || n > 6) return 0;
    if (k >= s.length || s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9) return n;
    return 0;
  }

  // Is the current line (at the cursor) a fenced code block start?
  // Returns the fence char (96 or 126) or 0.
  function fenceAtCursor() {
    curPeek(cur, peek);
    if (peek.indent > 3) return 0;
    const s = cur.s;
    const ch = peek.ch;
    if (ch !== 96 && ch !== 126) return 0;
    let k = peek.i;
    let run = 0;
    while (k < s.length && s.charCodeAt(k) === ch) { k++; run++; }
    if (run < 3) return 0;
    if (ch === 96 && s.indexOf('`', k) !== -1) return 0; // backticks in info
    return ch;
  }

  // Does the current line end a table? Rows end at hr, headings, blockquotes,
  // indented code, fences, lists, and HTML blocks of types 1-6. Setext
  // lines, plain text, definitions, and type-7 HTML become rows.
  function tableRowEndsHere() {
    curPeek(cur, peek);
    if (peek.indent > 3) return true; // indented code
    const content = curRest(cur);
    const ch = peek.ch;
    if (ch === 35 && atxAtCursor() !== 0) return true;
    if ((ch === 96 || ch === 126) && fenceAtCursor() !== 0) return true;
    if (ch === 62) return true; // blockquote
    if (ch === 60) {
      const hb = htmlBlockStart(content, false);
      return hb.t >= 1 && hb.t <= 6;
    }
    if (ch === 45 || ch === 42 || ch === 95 || ch === 43 || isDigit(ch)) {
      if (isHrLine(content) !== 0) return true;
      if (listMarkerAt(content, cur.col) !== null) return true;
    }
    return false;
  }

  // Does the current line interrupt an open paragraph? ATX, fences, hr,
  // blockquotes, lists (bullets always, ordered only when starting at 1),
  // and HTML blocks of types 1-6. Indented code, type-7 HTML, definitions,
  // and setext/table lines (handled by the caller) do not.
  function interruptsParagraph() {
    curPeek(cur, peek);
    if (peek.indent > 3) return false;
    const content = curRest(cur);
    const ch = peek.ch;
    if (ch === 35 && atxAtCursor() !== 0) return true;
    if ((ch === 96 || ch === 126) && fenceAtCursor() !== 0) return true;
    if (ch === 62) return true;
    if (ch === 60) {
      const hb = htmlBlockStart(content, true);
      return hb.t >= 1 && hb.t <= 6;
    }
    if (ch === 45 || ch === 42 || ch === 95 || ch === 43 || isDigit(ch)) {
      if (isHrLine(content) !== 0) return true;
      const m = listMarkerAt(content, cur.col);
      // An empty list item cannot interrupt a paragraph (spec example 285).
      // A paragraph directly in a list item is interrupted by an ordered
      // list with any start number (its first block is a text token, not
      // a paragraph); elsewhere only start 1 (or a bullet) interrupts.
      if (m !== null && !m.empty) {
        if (!m.ordered) return true;
        if (m.start === 1) return true;
        if (openLeaf !== null && openLeaf.node.t === 'p' && openLeaf.parent.t === 'item') return true;
      }
    }
    return false;
  }

  // Does a lazy line start a block (and therefore end the paragraph instead
  // of continuing it)? ATX, fences, hr, blockquotes, lists (any start
  // number — a lazy line starts a fresh chunk), and HTML blocks of any type.
  // Indented code, setext, definitions, and table delimiters do not.
  // Can a lazy line continue the fence `f`? Marked's list tokenizer ends
  // the item when the previous line (in the item's text) is blank,
  // indented 4+, or starts a fence, heading, HTML block, or hr. With no
  // content lines yet, the previous line is the opening fence line, so a
  // lazy line right after the opening never becomes content. A previous
  // lazy line is tested with R columns chopped off (marked slices it by
  // the item indent). `R` is the item's content indent.
  function fenceLazyAllowed(f, R) {
    if (f.lines.length === 0) return false;
    let m = f.lines[f.lines.length - 1];
    if (f.lastLazy) m = expandLeadingTabs(m, 0).slice(R);
    const lim = R < 3 ? R : 3;
    let i = 0;
    let indent = 0;
    let spaces = 0;
    let hasTab = false;
    while (i < m.length) {
      const c = m.charCodeAt(i);
      if (c === 32) { indent++; spaces++; i++; }
      else if (c === 9) { indent += 4; hasTab = true; i++; }
      else break;
    }
    if (i >= m.length) return false; // blank
    if (indent >= 4) return false;
    if (!hasTab && spaces <= lim) {
      const c = m.charCodeAt(i);
      if (c === 96 || c === 126) {
        let run = 0;
        while (i + run < m.length && m.charCodeAt(i + run) === c) run++;
        if (run >= 3) return false;
      }
      if (c === 35) {
        let run = 0;
        while (i + run < m.length && m.charCodeAt(i + run) === 35 && run < 7) run++;
        if (run >= 1 && run <= 6 && (i + run >= m.length || m.charCodeAt(i + run) === 32 || m.charCodeAt(i + run) === 9)) return false;
      }
      if (c === 60 && htmlBlockStart(m, false).t !== 0) return false;
      if ((c === 45 || c === 42 || c === 95) && isHrLine(m) !== 0) return false;
    }
    return true;
  }

  function lazyBlockStart() {
    curPeek(cur, peek);
    if (peek.indent > 3) return false;
    const content = curRest(cur);
    const ch = peek.ch;
    if (ch === 35 && atxAtCursor() !== 0) return true;
    if ((ch === 96 || ch === 126) && fenceAtCursor() !== 0) return true;
    if (ch === 62) return true;
    if (ch === 60) {
      const hb = htmlBlockStart(content, false);
      return hb.t >= 1 && hb.t <= 7;
    }
    if (ch === 45 || ch === 42 || ch === 95 || ch === 43 || isDigit(ch)) {
      if (isHrLine(content) !== 0) return true;
      if (listMarkerAt(content, cur.col) !== null) return true;
    }
    return false;
  }

  // The m value for the list lazy-setext rule: the raw line (after the outer
  // containers, before the item indent), tab-expanded, with the item indent
  // stripped. `preItem` is the cursor state before the item indent; `relR`
  // is the item's relative content indent.
  function computePrevM(preItem, relR) {
    if (preItem === null) return null;
    const raw = preItem.tab > 0
      ? ' '.repeat(preItem.tab) + cur.s.slice(preItem.i + 1)
      : cur.s.slice(preItem.i);
    const rawExp = expandTabs(raw, preItem.col);
    return rawExp.slice(relR > 0 ? relR : 0);
  }

  // Append a normal (non-lazy) paragraph continuation line.
  function appendPara(content, preItem) {
    const para = openLeaf.node;
    const parent = openLeaf.parent;
    let text = content;
    if (parent.t === 'item') {
      // After the item indent, a remaining indent of 4+ is stripped by the
      // code-rule merge.
      const ind = leadingIndent(content, cur.col);
      if (ind >= 4) text = stripCols(content, 4, cur.col);
      const pm = computePrevM(preItem, parent.relCol);
      if (pm !== null) para.prevM = pm;
    } else if (parent.t === 'q') {
      // Inside a quote: when a lazy line intervened (the previous line was
      // lazy), this line starts a new chunk, so a 4+ indent is stripped by
      // the code rule. Otherwise the indent is kept.
      if (qPrevLazy) {
        const ind = leadingIndent(content, cur.col);
        if (ind >= 4) text = stripCols(content, 4, cur.col);
      }
    }
    para.lines.push(text);
  }

  // Append a lazy paragraph continuation line. The quote rule (chunk-based)
  // applies first, then the list rule (indent + lazy-setext).
  function appendLazyPara(content, preItem, matched) {
    const para = openLeaf.node;
    const parent = openLeaf.parent;
    let text = content;
    // 1. The quote rule: the innermost unmatched quote's chunking.
    let quote = null;
    for (let fi = stack.length - 1; fi >= matched; fi--) {
      if (stack[fi].t === 'q') { quote = stack[fi]; break; }
    }
    let setextDone = false;
    if (quote !== null) {
      if (!quote.prevLazy) {
        // The chunk's first line: a 4+ indent is stripped by the code rule.
        const ind = leadingIndent(text, cur.col);
        if (ind >= 4) text = stripCols(text, 4, cur.col);
      } else {
        // Not the chunk's first line: a setext line gets 4 spaces prepended
        // (its up-to-3 leading spaces replaced).
        const sl = setextLevel(text);
        if (sl !== 0) {
          let i = 0;
          while (i < text.length && text.charCodeAt(i) === 32) i++;
          text = '    ' + text.slice(i);
          setextDone = true;
        }
      }
    }
    // Every unmatched quote saw a lazy line.
    for (let fi = matched; fi < stack.length; fi++) {
      if (stack[fi].t === 'q') stack[fi].prevLazy = true;
    }
    // 2. The list rule (when the paragraph is in an item).
    if (parent.t === 'item') {
      const relR = parent.relCol;
      const ind = leadingIndent(text, 0);
      if (relR > 0 && ind >= relR) {
        // The line (after the quote rule) now reaches the item content:
        // strip the item indent, then 4 more if the remainder is 4+.
        text = stripCols(text, relR, 0);
        const ind2 = leadingIndent(text, 0);
        if (ind2 >= 4) text = stripCols(text, 4, 0);
      } else if (ind >= 4) {
        text = stripCols(text, 4, 0);
      }
      // 3. The lazy-setext check: a setext line becomes a heading when the
      // lheading test on the previous line fails (m is empty).
      if (!setextDone) {
        const sl = setextLevelList(text);
        if (sl !== 0) {
          const m = para.prevM !== null && para.prevM !== undefined ? para.prevM : '';
          if (!lheadingTest(m)) {
            const rest = paraRemaining(para);
            if (rest !== '') {
              const h = { t: 'h', level: sl, text: rest.trim() };
              openLeaf.parent.children[openLeaf.idx] = h;
              openLeaf = null;
              return;
            }
          }
        }
      }
      const pm = computePrevM(preItem, parent.relCol);
      if (pm !== null) para.prevM = pm;
    }
    para.lines.push(text);
  }

  // Start a new paragraph with `content` as its first line.
  function startParagraph(content, preItem) {
    blankBeforeBlock();
    const para = { t: 'p', lines: [content], prevM: null };
    const parent = innermost();
    if (parent.t === 'item') {
      parent.empty = false;
      if (pendingItemPrevM !== null) {
        para.prevM = pendingItemPrevM;
      } else {
        const pm = computePrevM(preItem, parent.relCol);
        if (pm !== null) para.prevM = pm;
      }
    }
    addLeaf(para, true);
  }

  // Start a new block at the cursor (after container matching). Checks the
  // block starts in order: ATX, fence, hr, blockquote, list, HTML, indented
  // code, then a paragraph.
  function startBlock() {
    // List frames are transparent to container matching, so an open list
    // must be closed explicitly when a non-item block starts at its level.
    // (A marker for the same list keeps it open; anything else pops it.
    // An hr takes precedence over a list marker, so it pops the list too.)
    while (innermost().t === 'list') {
      const list = innermost();
      if (isHrLine(curRest(cur)) !== 0) {
        stack.pop();
        continue;
      }
      const saveI = cur.i;
      const saveCol = cur.col;
      const saveTab = cur.tab;
      const m = parseListMarker();
      cur.i = saveI;
      cur.col = saveCol;
      cur.tab = saveTab;
      if (m !== null && m.ordered === list.ordered && m.bullet === list.bullet) break;
      stack.pop();
    }
    curPeek(cur, peek);
    const content = curRest(cur);
    const ch = peek.ch;
    const s = cur.s;

    // ATX heading.
    if (peek.indent <= 3 && ch === 35) {
      const level = atxAtCursor();
      if (level !== 0) {
        blankBeforeBlock();
        let k = peek.i + level;
        // Skip spaces/tabs after the hashes.
        while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
        let text = s.slice(k);
        // Strip trailing spaces/tabs, then a closing sequence of #s
        // (preceded by a space/tab, or the whole text).
        let end = text.length;
        while (end > 0 && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
        let hashEnd = end;
        while (hashEnd > 0 && text.charCodeAt(hashEnd - 1) === 35) hashEnd--;
        if (hashEnd < end) {
          if (hashEnd === 0 || text.charCodeAt(hashEnd - 1) === 32 || text.charCodeAt(hashEnd - 1) === 9) {
            end = hashEnd;
            while (end > 0 && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
          }
        }
        text = text.slice(0, end);
        addLeaf({ t: 'h', level, text }, false);
        return;
      }
    }

    // Fenced code block.
    if (peek.indent <= 3 && (ch === 96 || ch === 126)) {
      const fch = fenceAtCursor();
      if (fch !== 0) {
        blankBeforeBlock();
        let k = peek.i;
        let run = 0;
        while (k < s.length && s.charCodeAt(k) === fch) { k++; run++; }
        // The info string: up to the end of the line, backslash escapes
        // resolved; the language is its first word.
        const info = unescapePunct(s.slice(k).trim());
        const lang = info.split(/\s/, 1)[0] || '';
        addLeaf(
          { t: 'fence', ch: fch, len: run, lang, lines: [], fenceIndent: peek.indent, closed: false, inContainer: stack.length > 1, lastLazy: false },
          true
        );
        return;
      }
    }

    // Thematic break.
    if (peek.indent <= 3 && (ch === 45 || ch === 42 || ch === 95)) {
      if (isHrLine(content) !== 0) {
        blankBeforeBlock();
        addLeaf({ t: 'hr' }, false);
        return;
      }
    }

    // Block quote.
    if (peek.indent <= 3 && ch === 62) {
      blankBeforeBlock();
      // Consume the '>' and one optional space/tab, then push a quote frame
      // and re-process the line's remainder as a new block.
      const q = { t: 'q', children: [], prevLazy: false };
      const qParent = innermost();
      qParent.children.push(q);
      if (qParent.t === 'item') qParent.empty = false;
      stack.push(q);
      // Advance the cursor past the marker.
      cur.i = peek.i;
      cur.col = peek.col;
      cur.tab = peek.tab;
      curAdvance1(cur); // the '>'
      consumeQuoteSpace(peek.indent);
      if (curRestBlank(cur)) {
        // An empty quote line: the quote stays open with no content.
        return;
      }
      startBlock();
      return;
    }

    // List.
    if (peek.indent <= 3 && (ch === 45 || ch === 43 || ch === 42 || isDigit(ch))) {
      const m = parseListMarker();
      if (m !== null) {
        startListItem(m);
        return;
      }
      curPeek(cur, peek); // parseListMarker may have moved peek
    }

    // HTML block.
    if (peek.indent <= 3 && ch === 60) {
      const hb = htmlBlockStart(content, false);
      if (hb.t !== 0) {
        blankBeforeBlock();
        const node = { t: 'html', type: hb.t, tag: hb.tag, lines: [content], ended: false };
        if (hb.t >= 1 && hb.t <= 5 && htmlBlockEnds(content, hb.t, hb.tag)) {
          node.ended = true;
        }
        addLeaf(node, true);
        return;
      }
    }

    // Indented code block.
    if (peek.indent >= 4) {
      blankBeforeBlock();
      const text = stripCols(content, 4, cur.col);
      addLeaf({ t: 'code', lines: [text] }, true);
      return;
    }

    // Paragraph.
    startParagraph(content, null);
  }

  // Start (or continue) a list with the marker `m` (the cursor is already
  // at the item content, positioned by parseListMarker).
  function startListItem(m) {
    let list = null;
    const parent = innermost();
    if (parent.t === 'list' && parent.ordered === m.ordered && parent.bullet === m.bullet) {
      list = parent;
    } else {
      blankBeforeBlock();
      list = {
        t: 'list', ordered: m.ordered, bullet: m.bullet, start: m.ordered ? m.start : 0,
        loose: false, sawBlank: false, children: [],
      };
      parent.children.push(list);
      if (parent.t === 'item') parent.empty = false;
      stack.push(list);
    }
    // A blank line before this item makes the list loose.
    if (list.sawBlank) list.loose = true;
    clearSawBlank();
    // The item's content indent is relative to the position after the outer
    // containers (the marker line's content start).
    const item = { t: 'item', relCol: m.contentCol - m.startCol, empty: true, children: [] };
    list.children.push(item);
    stack.push(item);
    if (m.empty) return;
    // The paragraph's prevM for the marker line is the post-marker content
    // with its leading tabs expanded (from the marker column).
    const s = cur.s;
    const postMarker = s.slice(m.markerEndIdx);
    let pm = postMarker;
    let end = 0;
    while (end < postMarker.length && (postMarker.charCodeAt(end) === 32 || postMarker.charCodeAt(end) === 9)) end++;
    if (end > 0) pm = expandTabs(postMarker.slice(0, end), m.markerCol) + postMarker.slice(end);
    pendingItemPrevM = pm;
    // The cursor is at the item content; process it as a block.
    startBlock();
    pendingItemPrevM = null;
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

// The code-block text rule (marked's code renderer): the lines joined with
// \n, with one trailing \n stripped and one added back when non-empty.
function codeText(lines) {
  if (lines.length === 0) return '';
  let text = lines.join('\n');
  if (text === '') return '';
  if (text.charCodeAt(text.length - 1) === 10) text = text.slice(0, -1);
  return text + '\n';
}

function renderBlocks(children, refs, out) {
  for (const node of children) renderBlock(node, refs, out);
}

function renderBlock(node, refs, out) {
  switch (node.t) {
    case 'p': {
      out.push('<p>');
      renderInline(parseInline(node.text, refs), out, false);
      out.push('</p>\n');
      break;
    }
    case 'h': {
      out.push('<h', String(node.level), '>');
      renderInline(parseInline(node.text, refs), out, false);
      out.push('</h', String(node.level), '>\n');
      break;
    }
    case 'hr': {
      out.push('<hr>\n');
      break;
    }
    case 'fence': {
      let lines = node.lines;
      // Backtick fences strip up to the fence indent from each content
      // line; tilde fences do not (a marked quirk).
      if (node.ch === 96 && node.fenceIndent > 0) {
        const stripped = new Array(lines.length);
        for (let k = 0; k < lines.length; k++) stripped[k] = stripCols(lines[k], node.fenceIndent, 0);
        lines = stripped;
      }
      out.push('<pre><code');
      if (node.lang !== '') out.push(' class="language-', escText(node.lang), '"');
      out.push('>', escAll(codeText(lines)), '</code></pre>\n');
      break;
    }
    case 'code': {
      out.push('<pre><code>', escAll(codeText(node.lines)), '</code></pre>\n');
      break;
    }
    case 'html': {
      out.push(node.lines.join('\n'));
      if (node.trailNL) out.push('\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let ci = 0; ci < node.header.length; ci++) {
        const a = node.aligns[ci];
        out.push('<th');
        if (a !== null) out.push(' align="', a, '"');
        out.push('>');
        renderInline(parseInline(node.header[ci], refs), out, false);
        out.push('</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (node.rows.length > 0) {
        out.push('<tbody>');
        for (const row of node.rows) {
          out.push('<tr>\n');
          for (let ci = 0; ci < row.length; ci++) {
            const a = node.aligns[ci];
            out.push('<td');
            if (a !== null) out.push(' align="', a, '"');
            out.push('>');
            renderInline(parseInline(row[ci], refs), out, false);
            out.push('</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
    case 'q': {
      out.push('<blockquote>\n');
      renderBlocks(node.children, refs, out);
      out.push('</blockquote>\n');
      break;
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      out.push('<', tag);
      if (node.ordered && node.start !== 1) out.push(' start="', String(node.start), '"');
      out.push('>\n');
      for (const item of node.children) renderListItem(item, node.loose, refs, out);
      out.push('</', tag, '>\n');
      break;
    }
  }
}

// Render one list item. In a loose list, paragraph children are wrapped in
// <p>; in a tight list they render bare. A task marker on the first
// paragraph becomes a checkbox (with a trailing space, as marked renders it).
function renderListItem(item, loose, refs, out) {
  out.push('<li>');
  if (item.children.length === 0) {
    out.push('</li>\n');
    return;
  }
  let checkbox = null;
  const first = item.children[0];
  if (first.t === 'p') {
    const text = first.text;
    if (
      text.length >= 4 &&
      text.charCodeAt(0) === 91 && // [
      (text.charCodeAt(1) === 32 || text.charCodeAt(1) === 120 || text.charCodeAt(1) === 88) && // space/x/X
      text.charCodeAt(2) === 93 // ]
    ) {
      let k = 3;
      while (k < text.length && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
      if (k > 3 && k < text.length) {
        checkbox = text.charCodeAt(1) === 32
          ? '<input disabled="" type="checkbox"> '
          : '<input checked="" disabled="" type="checkbox"> ';
        first.text = text.slice(k);
      }
    }
  }
  for (let ci = 0; ci < item.children.length; ci++) {
    const child = item.children[ci];
    if (child.t === 'p') {
      if (loose) {
        out.push('<p>');
        if (ci === 0 && checkbox !== null) out.push(checkbox);
        renderInline(parseInline(child.text, refs), out, false);
        out.push('</p>\n');
      } else {
        if (ci === 0 && checkbox !== null) out.push(checkbox);
        renderInline(parseInline(child.text, refs), out, false);
      }
    } else {
      renderBlock(child, refs, out);
    }
  }
  out.push('</li>\n');
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

// parse(markdown) returns the HTML marked 18.1.3 renders with default
// options (GFM on, breaks off). Line endings are normalized to \n first.
export function parse(markdown) {
  const src = markdown.replace(/\r\n?/g, '\n');
  const srcEndsNL = src.endsWith('\n');
  const lines = src.split('\n');
  if (srcEndsNL) lines.pop();
  const { root, refs } = parseBlocks(lines, srcEndsNL);
  const out = [];
  renderBlocks(root.children, refs, out);
  return out.join('');
}
