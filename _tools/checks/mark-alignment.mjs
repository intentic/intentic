#!/usr/bin/env node
/* A MARK BESIDE TEXT IS PLACED BY THE RULE, NOT BY A NUMBER SOMEBODY EYEBALLED.
 *
 * A bullet, a flower on a heading, a tick on a FAQ summary, a provider's logo in a row: a mark is a BOX and the
 * words beside it are a BASELINE GRID, and no flexbox keyword relates the two. `align-items: center` centres the
 * mark on the whole flex line, which is right until the words wrap and then parks the bullet between line one and
 * line two; `flex-start` puts its top at the row's content edge, half the leading above where the letters start.
 * So every call site reached for a hand-tuned `margin-top` instead — and tuned it against the type size it
 * happened to be sitting next to.
 *
 * THAT IS WHY THIS IS A GATE AND NOT A NOTE. The constant travels by copy-paste and the type context that
 * justified it does not, so one wrong answer becomes five: this site carried `0.2rem` twice, `0.35rem`, a
 * `top: 0.15rem`, an `mt-1.5` that was 3.6px out on a 20px line, and two different nudges for the same wordmark
 * lockup at two sizes. None of it was visible to a type-checker, a linter or a unit test — only to somebody
 * looking at a screenshot, which is exactly the reader a repository cannot rely on having.
 *
 * The fix is `.mark` in `_site/site/src/styles/global.css`: one line box tall (`1lh`), mark centred in it, so the
 * offset is computed from the row's own leading at every size and there is no number to go stale. `Bullet.astro`
 * and `Point.astro` are how a call site gets it without being able to place anything itself. This check keeps the
 * escape hatch shut: it refuses a vertical offset written onto a mark anywhere else, in markup or in CSS, because
 * a rule that can be quietly re-tuned per call site is the state this all started in.
 *
 * Deliberately NOT checked here: whether the rendered geometry is actually right. That needs a layout engine and
 * is `_site/site/scripts/check-alignment.mjs`, which measures every mark on every page in a real browser. This
 * one is the cheap half that runs on a bare checkout, and its job is to stop the browser check ever being
 * satisfied by re-tuning a constant instead of by using the primitive. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "../constants/src/node.mjs";

const root = repoRoot(import.meta.url);

// Where the marks are. The editor draws its own icons through a different system; widen this when that changes.
const ROOTS = [`_site/site/src`];

// A class attribute naming one of the house marks, or the wrapper that places them.
const MARK_IN_MARKUP = /<(?:Lotus|Lozenge|Bullet|Point)\b|class(?::list)?=["'{][^"'}]*\b(?:mark|lotus|lozenge|point)\b/;
/* The utilities that move a box up or down. `mb`/`pb` are in because a bottom nudge is the same trick upside
 * down, and `self-` is in because re-choosing the cross-axis alignment is how you opt back out of the rule. */
const VERTICAL_UTILITY =
    /(?:^|[\s"'{[])-?(?:mt|mb|pt|pb|top|translate-y)-[\w./[\]-]+|(?:^|[\s"'{[])self-(?:start|end|center|baseline|stretch)/;

// A selector that reaches a mark: the drawings, the wrapper, the row, and any `…-mark` a caller invented.
const MARK_SELECTOR = /\.(?:lotus|lozenge|mark|point)\b|\.[\w-]*-mark\b/;
// The properties that decide where a box sits on the line.
const VERTICAL_PROPERTY = /^\s*(margin-top|margin-block-start|padding-top|padding-block-start|top|inset-block-start|vertical-align|align-self|margin|inset)\s*:\s*([^;]+);/gm;
// `transform` only counts when it actually translates vertically: the FAQ tick rotates when it opens.
const VERTICAL_TRANSFORM = /^\s*transform\s*:\s*[^;]*translate(?:Y|3d)?\(/gm;
/* THE RULES THAT ARE ALLOWED TO PLACE A MARK, spelled exactly, so that `.mark` may say where a mark goes and
 * `.something .mark` still may not:
 *   `.mark`, `.point`  the primitive itself — the definition this check exists to protect.
 *   `.lockup .lotus`   the wordmark lockup, the one place an offset is the right answer: there the flower is
 *                      aligned on the LETTERS rather than on the line box, because Baloo 2 reserves descender
 *                      room the word "intentic" never uses. A metric of the typeface, one number in `em`, one
 *                      rule, read by both lockups. */
const ALLOWED = new Set([`.mark`, `.point`, `.lockup .lotus`]);
// Values that place nothing: a reset, or the zero a shorthand carries.
const INERT = /^(0|0px|0rem|auto|none|inherit|initial|unset|revert|baseline)$/;

const tracked = execFileSync(`git`, [`ls-files`, `-z`, ...ROOTS], { cwd: root, encoding: `utf8`, maxBuffer: 64 * 1024 * 1024 })
    .split(`\0`)
    // On disk as well as in the index: a deletion left unstaged is still listed by git and has nothing to read.
    .filter((path) => path !== `` && existsSync(`${root}/${path}`));

const findings = [];
const lineAt = (source, index) => source.slice(0, index).split(`\n`).length;

/* Comments blanked rather than cut, so every index below is still the index in the real file — a finding has to
 * name the line a person can open. */
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ` `));

/* THE INNERMOST RULES. CSS here nests (`@layer`, media queries, `&`), and a regex that reads one flat pass over
 * `selector { declarations }` matches exactly the blocks that hold declarations and skips the wrappers that hold
 * other blocks — which is the level a mark is styled at. */
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
