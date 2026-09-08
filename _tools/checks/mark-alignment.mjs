#!/usr/bin/env node
// A mark beside text is placed by `.mark` (_site/site/src/styles/global.css), sized to `1lh` and centered on the line's
// own leading; no flexbox alignment gets this right at every wrap. Refuses a vertical offset on a mark written anywhere
// else. Rendered geometry is checked separately, in a browser (check-alignment.mjs).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "../constants/src/node.mjs";

const root = repoRoot(import.meta.url);

// Where the marks live; the editor draws icons through a different system, not covered here.
const ROOTS = [`_site/site/src`];

// A class naming one of the house marks, or the wrapper component that places them.
const MARK_IN_MARKUP = /<(?:Lotus|Lozenge|Bullet|Point)\b|class(?::list)?=["'{][^"'}]*\b(?:mark|lotus|lozenge|point)\b/;
// Utilities that move a box vertically; `self-*` counts too, since it re-opts out of the centering rule.
const VERTICAL_UTILITY =
    /(?:^|[\s"'{[])-?(?:mt|mb|pt|pb|top|translate-y)-[\w./[\]-]+|(?:^|[\s"'{[])self-(?:start|end|center|baseline|stretch)/;

// A selector reaching a mark: the drawings, the wrapper, the row, or any caller-invented `…-mark`.
const MARK_SELECTOR = /\.(?:lotus|lozenge|mark|point)\b|\.[\w-]*-mark\b/;
// Properties that decide where a box sits on the line.
const VERTICAL_PROPERTY = /^\s*(margin-top|margin-block-start|padding-top|padding-block-start|top|inset-block-start|vertical-align|align-self|margin|inset)\s*:\s*([^;]+);/gm;
// Counts only when `transform` actually translates vertically; a rotation (the FAQ tick opening) doesn't.
const VERTICAL_TRANSFORM = /^\s*transform\s*:\s*[^;]*translate(?:Y|3d)?\(/gm;
// Selectors allowed to place a mark:
// `.mark`, `.point` the primitive itself
// `.lockup .lotus` the wordmark lockup, where the flower aligns on the letters (a type metric), not the line box
const ALLOWED = new Set([`.mark`, `.point`, `.lockup .lotus`]);
// Values that place nothing: a reset, or the zero a shorthand carries.
const INERT = /^(0|0px|0rem|auto|none|inherit|initial|unset|revert|baseline)$/;

const tracked = execFileSync(`git`, [`ls-files`, `-z`, ...ROOTS], { cwd: root, encoding: `utf8`, maxBuffer: 64 * 1024 * 1024 })
    .split(`\0`)
    // On disk as well as tracked: an unstaged deletion is still listed by git and has nothing to read.
    .filter((path) => path !== `` && existsSync(`${root}/${path}`));

const findings = [];
const lineAt = (source, index) => source.slice(0, index).split(`\n`).length;

// Comments blanked, not cut, so an index stays the real file's line number.
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ` `));

// CSS nests (`@layer`, media queries, `&`); one flat pass over `selector { declarations }` matches only the innermost
// blocks, the level a mark is actually styled at.
const rules = function* (css) {
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        yield { selector: rule[1].trim().replace(/\s+/g, ` `), body: rule[2], index: rule.index + rule[1].length };
    }
};

const scanCss = (path, css, offset = 0) => {
    for (const { selector, body, index } of rules(withoutComments(css))) {
        if (!MARK_SELECTOR.test(selector) || ALLOWED.has(selector)) {
            continue;
        }
        const at = `${path}:${lineAt(css, index + offset)}`;
        for (const [, property, value] of body.matchAll(VERTICAL_PROPERTY)) {
            if (INERT.test(value.trim()) || (property === `margin` && /^0\s|^0$/.test(value.trim()))) {
                continue;
            }
            findings.push({
                at,
                why: `\`${selector}\` sets \`${property}: ${value.trim()}\` — a mark's vertical place is \`.mark\`'s to compute, not a rule's to state`,
            });
        }
        if (VERTICAL_TRANSFORM.test(body)) {
            findings.push({ at, why: `\`${selector}\` translates a mark vertically: use \`.mark\` (or \`.lockup\`, for the wordmark) instead` });
        }
    }
};

for (const path of tracked) {
    const source = readFileSync(`${root}/${path}`, `utf8`);
    if (path.endsWith(`.css`)) {
        scanCss(path, source);
        continue;
    }
    if (!/\.(astro|vue|html)$/.test(path)) {
        continue;
    }
    // The template: a mark and a vertical utility in the same tag.
    for (const [i, line] of source.split(`\n`).entries()) {
        if (MARK_IN_MARKUP.test(line) && VERTICAL_UTILITY.test(line)) {
            findings.push({
                at: `${path}:${i + 1}`,
                why: `a vertical offset on a mark: \`<Bullet>\` / \`<Point>\` place it on the line already, and a nudge here is right only for the type size it was typed at`,
            });
        }
    }
    // The component's own stylesheet, by the same rules as a global one.
    for (const block of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
        scanCss(path, block[1], block.index + block[0].indexOf(block[1]));
    }
}

if (findings.length > 0) {
    for (const { at, why } of findings) {
        console.error(`${at}  ${why}`);
    }
    console.error(`\n${findings.length} hand-placed mark(s). The rule is \`.mark\` in _site/site/src/styles/global.css; the way to use it is Bullet.astro or Point.astro.`);
    process.exit(1);
}

console.log(`${tracked.length} site files: every mark beside text is placed by \`.mark\`, and the only vertical offset is the wordmark lockup's`);
