#!/usr/bin/env node
/* Whitespace-tolerant copy replacer, for cutting prose in .astro pages where a sentence is wrapped
 * across several indented lines. Reads a JSON job on stdin:
 *
 *   { "file": "path", "pairs": [["old text, whitespace-normalised", "new text"], ...] }
 *
 * Each `old` is matched against the file with every run of whitespace treated as \s+, so the wrapping in
 * the source does not have to be reproduced by hand. A pair that does not match EXACTLY once is reported
 * and skipped rather than guessed at: a silent near-miss would edit the wrong sentence. Prettier reflows
 * the replacement afterwards, so `new` is written as one line.
 */
import { readFileSync, writeFileSync } from "node:fs";

const job = JSON.parse(readFileSync(0, "utf8"));
const original = readFileSync(job.file, "utf8");
let text = original;
const missed = [];

for (const [oldText, newText] of job.pairs) {
    const pattern = oldText
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+");
    const re = new RegExp(pattern, "g");
    const hits = text.match(re);
    if (!hits || hits.length !== 1) {
        missed.push({ hits: hits ? hits.length : 0, head: oldText.slice(0, 60) });
        continue;
    }
    text = text.replace(re, () => newText);
}

writeFileSync(job.file, text);
console.log(`${job.file}: applied ${job.pairs.length - missed.length}/${job.pairs.length}`);
for (const m of missed) console.log(`  MISS(${m.hits}) ${m.head}`);
