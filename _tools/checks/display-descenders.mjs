#!/usr/bin/env node
// Clipped-background text paints only inside the padding box, so a descender below it is invisible unless
// `padding-block-end` buys room and a matching negative `margin-block-end` removes that room from layout. Finds
// every rule that paints letters that way — by the declaration, not by a list — and checks the pair is declared.
import { readFileSync } from "node:fs";
import { repoRoot } from "../constants/src/node.mjs";
import { finish } from "./lib/report.mjs";
import { subjectFiles } from "./lib/repo.mjs";

const root = repoRoot(import.meta.url);

// The declaration that turns a background into letters; the prefixed spelling alone does it in WebKit.
const CLIPPED = /(?:^|[\s;{])(?:-webkit-)?background-clip\s*:\s*text\s*(?:;|$)/;
// The room bought for the tails, and the takeback that keeps it out of layout.
const PADDING = /(?:padding-block-end|padding-bottom)\s*:/;
const TAKEBACK = /(?:margin-block-end|margin-bottom)\s*:\s*calc\(\s*-1\s*\*/;

const tracked = subjectFiles(`*.css`, `*.vue`, `*.astro`, `*.html`);

// Comments blanked, not cut, so an index stays the real file's line number.
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ` `));

// CSS nests (`@layer`, media queries, `&`); one flat pass over `selector { declarations }` matches only the innermost
// blocks, the level type is actually painted at.
const rules = function* (css) {
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        yield { selector: rule[1].trim().replace(/\s+/g, ` `), body: rule[2], index: rule.index + rule[1].length };
    }
};

const findings = [];
const clipped = [];

const scanCss = (path, css, offset = 0) => {
    for (const { selector, body, index } of rules(withoutComments(css))) {
        if (!CLIPPED.test(body)) {
            continue;
        }
        const at = `${path}:${css.slice(0, index + offset).split(`\n`).length}`;
        clipped.push(at);
        if (!PADDING.test(body)) {
            findings.push(`${at}  \`${selector}\` paints its letters as a clipped background but declares no \`padding-block-end\`: descenders will not be painted`);
        }
        if (!TAKEBACK.test(body)) {
            findings.push(`${at}  \`${selector}\` has descender padding with no matching negative \`margin-block-end\`: the padding will show as a gap under every heading`);
        }
    }
};

for (const path of tracked) {
    const source = readFileSync(`${root}/${path}`, `utf8`);
    if (path.endsWith(`.css`)) {
        scanCss(path, source);
        continue;
    }
    for (const block of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
        scanCss(path, block[1], block.index + block[0].indexOf(block[1]));
    }
}

finish(
    [[`Clipped display type with no descender clearance. A letter's tail is either paid for in padding or it is not painted`, findings]],
    [`${clipped.length} clipped-type rule(s) across ${tracked.length} stylesheets keep their descender padding`],
);
