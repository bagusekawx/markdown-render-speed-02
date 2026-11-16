// main.ts — entrypoint for markdown-render-speed-02.
// Reads cases from $MAKEFUN_INPUT_DIR/cases.json (or /input/cases.json),
// renders each with parse.js, writes $MAKEFUN_OUTPUT_DIR/html.json
// (or /output/html.json).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";

const cases = JSON.parse(readFileSync(join(inputDir, "cases.json"), "utf8"));
const out = cases.map((c: { id: string; markdown: string }) => ({
  id: c.id,
  html: parse(c.markdown),
}));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(out));
