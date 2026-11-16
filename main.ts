// Driver for the markdown-render-speed-02 entry. The harness runs
// `node /bot/main.ts`: it reads every case from /input/cases.json, renders
// each one alone with parse() from ./parse.js, and writes /output/html.json
// as a JSON array of the HTML strings, one per case, in the cases' order.
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.
//
// The driver is deliberately boring: the only work that matters is parse().
// What it adds over the baseline's driver is failure context — a bad input
// shape or a case that throws fails loudly naming the case, instead of
// dying with an inscrutable TypeError — and it creates the output
// directory rather than assuming the harness made it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
if (!Array.isArray(raw)) {
  throw new Error(`cases.json is not an array (got ${typeof raw})`);
}
const cases = raw as Case[];
for (let i = 0; i < cases.length; i++) {
  if (typeof cases[i]?.markdown !== 'string') {
    throw new Error(`case ${i} (id ${String(cases[i]?.id)}) has no markdown string`);
  }
}

const rendered = new Array<string>(cases.length);
let i = 0;
try {
  for (; i < cases.length; i++) {
    rendered[i] = parse(cases[i].markdown);
  }
} catch (err) {
  // Which case broke is the one thing worth knowing when a run fails.
  console.error(`parse failed on case ${i} (id ${cases[i]?.id})`);
  throw err;
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
