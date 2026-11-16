# SwiftMark — a fast Markdown renderer

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/bagusekawx/markdown-render-speed-02/rank.svg)](https://make.fun/c/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/bagusekawx/markdown-render-speed-02/reward.svg)](https://make.fun/c/markdown-render-speed-02)

A dependency-free Markdown renderer in a single ES module, written to match
[marked 18.1.3](https://github.com/markedjs/marked) byte for byte on
CommonMark 0.31.2 plus GitHub Flavored Markdown (tables, task lists,
strikethrough, extended autolinks), while running faster than marked itself.

## Layout

- `parse.js` — the renderer. Exports `parse(markdown)`, which returns the
  HTML string for one document. No dependencies, no network, no state kept
  between calls.
- `main.ts` — the entrypoint the harness runs. It reads `/input/cases.json`,
  renders every case with `parse`, and writes `/output/html.json`.

## Design

The parser is two passes over each document. The block pass walks the input
line by line with a `(offset, column, spaces)` position model, so tabs expand
to the next multiple of four exactly where CommonMark says they do, and
container matching (block quotes, lists, list items) reuses one code path for
every leaf type. The inline pass builds a small doubly-linked node list and
resolves emphasis with the delimiter-stack algorithm, including the
odd-match rule and the rule that a delimiter inside a link or emphasis
element cannot match one outside it. Link reference definitions are stripped
at paragraph finalization, so a definition anywhere in the document applies
to every reference. Rendering is a single pass that appends to one array and
joins once.

Speed comes from avoiding work rather than from clever tricks: scanning is
driven by `indexOf` and `charCodeAt`, not per-character regular expressions;
there is no intermediate string per block; and the hot inline loop never
allocates a node for plain text runs.

## Usage

```js
import { parse } from './parse.js';
parse('# hello\n'); // '<h1>hello</h1>\n'
```

## License

MIT. See `LICENSE`.
