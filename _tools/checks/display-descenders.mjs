#!/usr/bin/env node
// Clipped-background text paints only inside the padding box, so a descender below it is invisible unless
// `padding-block-end` buys room and a matching negative `margin-block-end` removes that room from layout. Checks that
// the pair stays declared together and nothing overrides the takeback.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "../constants/src/node.mjs";

const root = repoRoot(import.meta.url);

// Selectors that paint clipped-background text; add a new one here or it goes unchecked.
const CLIPPED_TYPE = [
    { file: `_site/site/src/styles/global.css`, selector: `.display`, marks: [`.display`] },
    { file: `_editor/web/src/skins/sanctum.css`, selector: `[data-skin="sanctum"] h1.text-4xl`, marks: [] },
];

// Matches a `.display` element in markup, and a margin utility that would override its descender takeback.
const MARK_CLASS = /\bclass=["'][^"']*\bdisplay\b[^"']*["']/;
const BOTTOM_MARGIN_UTILITY = /\b(?:sm:|md:|lg:|xl:|2xl:|max-sm:|max-md:|max-lg:)?(?:mb|my|m)-(?!0\b)[\w./[\]-]+/;

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

// Checks that nothing overrides the takeback from outside: a margin utility in markup, or a CSS rule on the mark whose
// margin isn't the takeback itself.
const tracked = execFileSync(`git`, [`ls-files`, `-z`, `_site/site/src`, `_editor/web/src`, `_editor/ui/src`], {
    cwd: root,
    encoding: `utf8`,
    maxBuffer: 64 * 1024 * 1024,
})
    .split(`\0`)
    // Skips a path git lists but that no longer exists on disk (an unstaged deletion).
    .filter((path) => existsSync(`${root}/${path}`) && path !== ``);

const marks = CLIPPED_TYPE.flatMap(({ marks: selectors }) => selectors);

for (const path of tracked) {
    if (!/\.(astro|vue|css|html)$/.test(path)) {
        continue;
    }
    const lines = readFileSync(`${root}/${path}`, `utf8`).split(`\n`);
    let ruleTargetsMark = false;
    for (const [i, line] of lines.entries()) {
        const at = `${path}:${i + 1}`;
        if (MARK_CLASS.test(line) && BOTTOM_MARGIN_UTILITY.test(line)) {
            findings.push({
                at,
                why: `a bottom-margin utility on a \`.display\` element cancels the descender takeback and leaves a gap: move the spacing to a wrapper`,
            });
        }
        if (!path.endsWith(`.css`)) {
            continue;
        }
        if (line.includes(`{`)) {
            ruleTargetsMark = marks.some((mark) => line.slice(0, line.indexOf(`{`)).includes(mark));
        }
        if (!ruleTargetsMark) {
            continue;
        }
        const margin = /^\s*margin(-bottom)?:\s*(.+);/.exec(line);
        if (margin && !margin[2].includes(`var(--display-descender)`)) {
            findings.push({
                at,
                why: `sets the bottom margin of a \`.display\` element without the descender takeback: end the value with \`calc(-1 * var(--display-descender))\``,
            });
        }
    }
}

if (findings.length > 0) {
    for (const { at, why } of findings) {
        console.error(`${at}  ${why}`);
    }
    console.error(`\n${findings.length} problem(s) with clipped display type. A letter's tail is either paid for in padding or it is not painted.`);
    process.exit(1);
}

console.log(`${CLIPPED_TYPE.length} clipped-type rules keep their descender padding, and nothing overrides the takeback`);
