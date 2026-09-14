#!/usr/bin/env node
// Clipped-background text paints only inside the padding box, so a descender below it is invisible unless
// `padding-block-end` buys room and a matching negative `margin-block-end` removes that room from layout. Checks
// that the pair stays declared together wherever type is painted that way.
//
// The site's `.display` used to be checked here, along with a scan of every template for a bottom-margin utility
// that would cancel its takeback. The headline is plain ink now — the carved-stone fill and its bevel came off —
// so it paints its own descenders, and both of those guards went with it.
import { readFileSync } from "node:fs";
import { repoRoot } from "../constants/src/node.mjs";

const root = repoRoot(import.meta.url);

// Selectors that paint clipped-background text; add a new one here or it goes unchecked.
const CLIPPED_TYPE = [{ file: `_editor/web/src/skins/sanctum.css`, selector: `[data-skin="sanctum"] h1.text-4xl` }];

const findings = [];

// Reads each rule's own block, not the whole file, so an unrelated selector's padding cannot pass for this one.
for (const { file, selector } of CLIPPED_TYPE) {
    const source = readFileSync(`${root}/${file}`, `utf8`);
    const start = source.indexOf(`${selector} {`);
    if (start === -1) {
        findings.push({
            at: file,
            why: `no rule for \`${selector}\` — if the clipped-type rule moved or went away, update CLIPPED_TYPE in this script`,
        });
        continue;
    }
    const block = source.slice(start, source.indexOf(`\n    }`, start));
    const line = source.slice(0, start).split(`\n`).length;
    if (!/padding-block-end:/.test(block)) {
        findings.push({
            at: `${file}:${line}`,
            why: `\`${selector}\` paints its letters as a clipped background but declares no \`padding-block-end\`: descenders will not be painted`,
        });
    }
    if (!/margin-block-end:\s*calc\(-1 \*/.test(block)) {
        findings.push({
            at: `${file}:${line}`,
            why: `\`${selector}\` has descender padding with no matching negative \`margin-block-end\`: the padding will show as a gap under every heading`,
        });
    }
}

if (findings.length > 0) {
    for (const { at, why } of findings) {
        console.error(`${at}  ${why}`);
    }
    console.error(`\n${findings.length} problem(s) with clipped display type. A letter's tail is either paid for in padding or it is not painted.`);
    process.exit(1);
}

console.log(`${CLIPPED_TYPE.length} clipped-type rule keeps its descender padding`);
