#!/usr/bin/env node
/* THE TAIL OF A "g" IS NOT A STYLE CHOICE, AND THIS IS THE GATE THAT KEEPS IT.
 *
 * The site's display type and the app's one display heading are painted as a BACKGROUND clipped to the shape of
 * the letters (`background-clip: text` over three noise-and-gradient layers, which is what makes them read as cut
 * stone rather than flat gold). A background is painted across an element's padding box and stops there, so any
 * part of a glyph that hangs below that box is not painted at all: not clipped raggedly, not faded, simply
 * absent. Playfair's descenders are long, so a heading whose line box is short loses the tails of g, y, p, j, q
 * outright while every other letter looks perfect. That is the bug, and it came back four separate times.
 *
 * IT CAME BACK BECAUSE THE OLD FIX WAS A NUMBER SOMEBODY HAD TO REMEMBER. The clearance used to come from
 * `line-height`, and in Tailwind a size utility carries its own leading: `text-3xl` is 1.2, `text-4xl` is 1.111,
 * `leading-none` is 1, and a utility outranks the component layer the display recipe lives in. So the recipe's
 * own 1.24 was overridden by the very class that made the heading big, and staying unbroken depended on every
 * author writing `leading-tight` at every call site forever. Most did. The ones who did not shipped clipped
 * headings on the docs layout, the reference layout, the legal pages, the download page, the changelog and 404.
 *
 * SO THE CLEARANCE IS NOW STRUCTURAL: `padding-block-end` buys the descender room inside the painted box, and a
 * matching negative `margin-block-end` takes the same amount back out of the layout, so the letters gain their
 * tails and nothing below them moves. It holds at any leading, including 1, which is the point: the call site
 * cannot get it wrong by forgetting something.
 *
 * WHAT IS LEFT TO GUARD IS THE PAIR ITSELF, and that is what this checks:
 *
 *   1. Each rule that paints letters with a clipped background declares BOTH halves. Delete the padding and the
 *      descenders go; delete the negative margin and every heading grows a gap nobody asked for.
 *   2. Nothing sets a bottom margin on one of those elements from outside, because that wins over the takeback
 *      and leaves the padding standing as dead space. In markup that is an `mb-*` / `my-*` / `m-*` utility on an
 *      element that also carries the display class; in CSS it is a rule whose selector targets one of them and
 *      whose `margin` shorthand or `margin-bottom` is not the negative takeback.
 *
 * Deliberately NOT checked: how deep the padding is. 0.2em clears Playfair with room to spare, but the number
 * belongs to whoever is looking at the type, not to a script that cannot see it. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "../constants/src/node.mjs";

const root = repoRoot(import.meta.url);

/* THE RULES THAT PAINT LETTERS AS A CLIPPED BACKGROUND, each named by the selector it is declared under. Two
 * today: the site's display recipe, and the app skin's single display heading. A THIRD ONE IS THE REASON THIS
 * LIST IS HERE — add it, or the next stone heading gets its own quiet regression. */
const CLIPPED_TYPE = [
    { file: `_site/site/src/styles/global.css`, selector: `.display`, marks: [`.display`] },
    { file: `_editor/web/src/skins/sanctum.css`, selector: `[data-skin="sanctum"] h1.text-4xl`, marks: [] },
];

// The class that marks a clipped-type element in markup, and the utilities that would fight the takeback.
const MARK_CLASS = /\bclass=["'][^"']*\bdisplay\b[^"']*["']/;
const BOTTOM_MARGIN_UTILITY = /\b(?:sm:|md:|lg:|xl:|2xl:|max-sm:|max-md:|max-lg:)?(?:mb|my|m)-(?!0\b)[\w./[\]-]+/;

const findings = [];

/* PART ONE: THE PAIR IS STILL DECLARED. Read each rule's own block rather than the whole file, so a padding
 * declared on some unrelated selector three hundred lines away cannot pass for this one. */
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

/* PART TWO: NOBODY OVERRIDES THE TAKEBACK FROM OUTSIDE. In markup, a bottom-margin utility on the element that
 * carries the mark class; in the stylesheets, a rule that targets the mark and sets a bottom margin that is not
 * the takeback itself. `margin: … 0` is the exact shape that caused this on the landing page. */
const tracked = execFileSync(`git`, [`ls-files`, `-z`, `_site/site/src`, `_editor/web/src`, `_editor/ui/src`], {
    cwd: root,
    encoding: `utf8`,
    maxBuffer: 64 * 1024 * 1024,
})
    .split(`\0`)
    .filter((path) => path !== ``);

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
