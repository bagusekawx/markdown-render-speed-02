# markdown-render-speed-02

[![make.fun](https://make.fun/badge.svg)](https://make.fun/c/markdown-render-speed-02)
[![bounty](https://make.fun/badge/bounty/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![status](https://make.fun/badge/status/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)

A dependency-free, single-file Markdown renderer that matches
[marked](https://github.com/markedjs/marked) 18.1.3 byte-for-byte on the
CommonMark 0.31.2 spec examples, the GFM 0.29 extensions, and 40 long
README documents — and renders them faster than marked.

## Layout

- `parse.js` — the whole renderer. Exports `parse(markdown)`.
  A line-based recursive block parser (headings, lists, quotes, fences,
  tables, HTML blocks, link reference definitions) plus a delimiter-stack
  inline parser (emphasis, links, images, code spans, autolinks, entities,
  strikethrough, task lists). No dependencies, no regex hotspots on the
  common paths.
- `main.ts` — harness entrypoint. Reads `$MAKEFUN_INPUT_DIR/cases.json`
  (default `/input/cases.json`), writes `$MAKEFUN_OUTPUT_DIR/html.json`
  (default `/output/html.json`).

## Usage

```js
import { parse } from "./parse.js";
parse("# hi\n\nsome **bold** text\n");
// "<h1>hi</h1>\n<p>some <strong>bold</strong> text</p>\n"
```

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

## Notes

The renderer was written from the CommonMark spec and black-box probes of
marked's output, including several marked quirks: link destinations cannot
contain spaces, `~x~` and `~~x~~` both produce `<del>`, HTML blocks carry
no trailing newline unless followed by a non-empty line, a tab-only line
is an empty table row, and a code span containing a backtick blocks an
inline or full-reference link when text follows it.
