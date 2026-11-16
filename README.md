# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/bagusekawx/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/bagusekawx/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown parser written from scratch that renders byte-for-byte the HTML marked 18.1.3 renders (CommonMark 0.31.2 + GFM, default options) — and renders it faster. Single-pass block parser plus an inline scanner that mirrors marked's own quirks: its emphasis-masking, its delimiter resolver, its HTML-block trailing-newline rule, its list-item text handling.

`parse.js` holds the parser (`parse(markdown)` → HTML string). `main.ts` is the harness driver: it reads `/input/cases.json` and writes `/output/html.json`.

## Results

720/720 practice cases identical to marked 18.1.3 (680 spec examples + 40 generated documents). Local benchmark on the practice set: ~500 ms per full pass vs ~810 ms for marked — about 1.6× faster.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<cases dir> MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=2vrn35hh&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
