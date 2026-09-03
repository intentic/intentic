#!/usr/bin/env node
/* THE DESIGN SYSTEM BYPASS, BLOCKED WHERE IT IS TYPED RATHER THAN COUNTED AFTER THE FACT.
 *
 * A theme exists to make a decision once. `bg-[#090706]` is that decision being made again, inline, by whoever
 * was in the file — and the cost is not the one line: it is that a palette change lands everywhere except the
 * places that opted out of it. The chores probe in _sandbox/sandbox-contract/src/chores/stack.ts already COUNTS
 * these and wakes an agent when the number climbs. This is the other half: a gate that stops the number climbing
 * in the first place, so the chore has less to find.
 *
 * WHAT IT MATCHES, and deliberately not more. Two arbitrary values only: a colour that is not in the palette,
 * and a size in pixels. `grid-cols-[1fr_auto]`, `w-[calc(100%-2rem)]`, `max-w-[64ch]` and `text-[0.8125rem]` are
 * Tailwind working as designed and a check that flagged them would be an objection to the framework rather than
 * a finding about this repository. A colour and a px are the two things the theme definitely already has an
 * answer for: `--color-*` and a `--spacing` scale in 4px steps.
 *
 * ONLY INSIDE A CLASS ATTRIBUTE, which is the difference between this and a plain grep. The pattern's own
 * documentation says `bg-[#3b82f6]`; the extension surface note says `w-[37px]`; the developer docs page prints
 * `<code>w-[37px]</code>` to teach the rule. A text search calls all three violations and is wrong three times,
 * which is how a check earns the reputation that gets it switched off. Prose cannot style anything, so prose is
 * not scanned — a bypass has to be somewhere a browser would actually read it.
 *
 * WHY A SCRIPT AND NOT AN OXLINT RULE. Every one of these lives in markup: a `class` on a Vue template element,
 * an attribute in an .astro body. An oxlint JS plugin sees a .vue file's <script> block and an .astro file's
 * frontmatter, and nothing after it — measured, not assumed: on SecretField.vue the last node a plugin is
 * offered is on line 7 and the bypass is on line 89; on Footer.astro the last is line 136 and the bypass is on
 * line 143. A rule written there would have caught none of the eight this started with. The reach, not the ergonomics, is
 * what picks the tool. The one place a plugin WOULD have reached — class strings in .ts, which is how the kit
 * itself holds them (`twMerge` calls in ui.ts, the variant tables in row.ts) — is covered here instead, so
 * there is no half of this the linter is quietly better at.
 *
 * HOW AN EXCEPTION IS SPELLED: an entry in ALLOWED, keyed by file AND by the exact class, carrying the reason.
 * Not a per-file waiver — a file waved through stops being checked the day someone adds a real bypass to it —
 * and not a comment pragma, because these sit inside an opening tag, where no comment is legal. An entry whose
 * class is no longer in the file is reported as stale, so the list cannot quietly outlive the code it excuses:
 * that is what caught the six below being retired, rather than anyone remembering to come back here. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "../constants/src/node.mjs";

const root = repoRoot(import.meta.url);

/* Where a class list is written as MARKUP. Mirrors MARKUP_GLOBS in _sandbox/sandbox-contract/src/chores/stack.ts:
 * the probe that counts these and the gate that blocks them have to look in the same places, or they disagree
 * about whether main is clean and the chore fires on a repository this check calls green. */
const MARKUP = /\.(?:vue|tsx|jsx|html|svelte|astro)$/u;

/* Where a class list is written as a STRING, which the probe's globs do not cover and this deliberately does.
 * The design kit holds its own classes this way — `twMerge` in ui.ts, the density tables in row.ts — so it is
 * the one file type where a bypass would sit in the component library itself and be inherited by every call
 * site rather than affecting one screen. Zero hits today, which is the point: it is cheap to keep at zero. */
const SCRIPT = /\.(?:ts|mts|cts)$/u;

/* Mirrors BYPASS_PATTERN in that same file, with the value captured rather than only detected so the report and
 * the ALLOWED key can name the whole class. The leading `-` anchors the match to a utility prefix (`bg-`,
 * `max-w-`, `ring-`), so an array index or a lone bracket cannot be read as a class. */
const BYPASS = /[\w-]*-\[(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\(|[0-9]+(?:\.[0-9]+)?px)[^\]]*\]/gu;

/* THE CLASS ATTRIBUTES OF EVERY FRAMEWORK IN THIS REPO, in one expression: plain `class`, Vue's `:class` and
 * `v-bind:class`, Astro's `class:list`, JSX's `className`. The lookbehind keeps `:class` from also matching as
 * a bare `class` at the offset one character in, which would report every finding twice. */
const CLASS_ATTR = /(?<![\w:-])(?:(?::|v-bind:)?class(?::list)?|className)\s*=\s*/gu;

/* THE TWO THAT ARE DERIVED RATHER THAN CHOSEN, which is the only kind of value left here.
 *
 * Six others started in this list and are gone from it, because a token was the right answer and the objection
 * to minting one was weaker than it sounded. `bg-[#090706]` is `--color-ground` in the site palette; the phone
 * width, the mask blur and the hairline are `--container-phone`, `--blur-mask` and `--ring-hairline` in the kit;
 * two figure caps became rem, which is what every other cap on that site already is. None of them moved a pixel.
 * "A colour used once is not a scale" was the argument for leaving the first, and it was wrong: a theme entry
 * costs one line, and what it buys is that the next palette change reaches the footer.
 *
 * What is left is different in kind. Both of these are a number COMPUTED from the geometry around them, and a
 * token would name the call site rather than a concept — `--spacing-commit-box` is not a step on any scale, it
 * is "the height of that one box" moved somewhere harder to find. The derivation is the documentation, so it is
 * written out here and next to the class, and the value stays where the arithmetic can be checked against the
 * element it describes. */
const ALLOWED = new Map([
    [
        `_site/site/src/pages/about.astro`,
        new Map([
            [
                `-left-[4.5px]`,
                `centres an 8px dot (h-2 w-2) on the 1px rule of the enclosing "border-l border-line": half the dot (4) plus half the rule (0.5). Derived from two things on the element itself, so it tracks them rather than the spacing scale — which is in 4px steps and correctly has no half-pixel.`,
            ],
        ]),
    ],
    [
        `_editor/web/src/pages/workspace/ReviewPanel.vue`,
        new Map([
            [
                `max-h-[142px]`,
                `eight rows exactly: 8 x 16.5px (text-xs at leading-snug) + 8px of py-1 + the 2px border. max-h-36 (144px) would add a 2px sliver of a ninth row under the eighth, which is the visual bug this number was picked to avoid.`,
            ],
        ]),
    ],
]);

/** The index of the brace closing the one at `start`. JSX and Astro hold an expression there, and an expression
 *  nests: counting depth rather than taking the first `}` is what keeps `class={cond ? {a} : {b}}` whole. */
const closingBrace = (text, start) => {
    let depth = 0;
    for (let at = start; at < text.length; at++) {
        if (text[at] === `{`) {
            depth += 1;
            continue;
        }
        if (text[at] !== `}`) {
            continue;
        }
        depth -= 1;
        if (depth === 0) {
            return at;
        }
    }
    return text.length;
};

/** Every class-attribute value in a file, as `{ value, offset }`. Scans the whole text rather than line by line
 *  because a `:class="[...]"` binding routinely spans several, and a per-line reader sees half a class list. */
const classValues = (text) => {
    const found = [];
    CLASS_ATTR.lastIndex = 0;
    for (let match = CLASS_ATTR.exec(text); match !== null; match = CLASS_ATTR.exec(text)) {
        const start = match.index + match[0].length;
        const open = text[start];
        const quoted = open === `"` || open === `'` || open === `\``;
        /* -1 covers both the unquoted attribute (`class=foo`, no delimiter to scan to) and the unterminated one.
         * Neither is this check's to object to: a file that cannot be parsed has a louder problem than a colour. */
        const end = quoted ? text.indexOf(open, start + 1) : open === `{` ? closingBrace(text, start) : -1;
        if (end === -1) {
            continue;
        }
        found.push({ value: text.slice(start + 1, end), offset: start + 1 });
        CLASS_ATTR.lastIndex = end + 1;
    }
    return found;
};

const lineAt = (text, offset) => text.slice(0, offset).split(`\n`).length;

/** A comment line, by the same cheap test path-literals.mjs uses. This is what keeps the pattern's own
 *  documentation from being reported as a violation of itself: stack.ts spells `bg-[#3b82f6]` to explain what
 *  it matches, and extensionSurface.test.ts spells `w-[37px]` to explain what it cannot promise. */
const isComment = (line) => {
    const start = line.trim();
    return start.startsWith(`*`) || start.startsWith(`//`) || start.startsWith(`/*`);
};

/** Each line as `{ value, offset }`, so a script file can be scanned with the same machinery as an attribute. */
const lineSpans = (text) => {
    const spans = [];
    let offset = 0;
    for (const line of text.split(`\n`)) {
        spans.push({ value: line, offset });
        offset += line.length + 1;
    }
    return spans;
};

/** The parts of a file worth looking at. In markup a class lives in an attribute and nowhere else, so that is
 *  the unit and prose falls out for free. In TypeScript it is a bare string with no attribute to anchor on, so
 *  the unit is the line and the comments are dropped by hand — looser, and affordable precisely because the
 *  measurement says the non-comment side is empty today. */
const scannable = (path, text) => (MARKUP.test(path) ? classValues(text) : lineSpans(text).filter((span) => !isComment(span.value)));

const tracked = execFileSync(`git`, [`ls-files`, `-z`], { cwd: root, encoding: `utf8`, maxBuffer: 64 * 1024 * 1024 })
    .split(`\0`)
    .filter((path) => path !== `` && (MARKUP.test(path) || SCRIPT.test(path)));

const findings = [];
const seen = new Map();
for (const path of tracked) {
    let text;
    try {
        text = readFileSync(`${root}/${path}`, `utf8`);
    } catch {
        continue; // a symlink to nowhere, or a path removed since `ls-files` answered
    }
    const allowed = ALLOWED.get(path);
    for (const { value, offset } of scannable(path, text)) {
        BYPASS.lastIndex = 0;
        for (let hit = BYPASS.exec(value); hit !== null; hit = BYPASS.exec(value)) {
            const found = hit[0];
            if (allowed?.has(found)) {
                seen.set(`${path}\0${found}`, true);
                continue;
            }
            findings.push({ at: `${path}:${lineAt(text, offset + hit.index)}`, found });
        }
    }
}

const stale = [];
for (const [path, classes] of ALLOWED) {
    for (const value of classes.keys()) {
        if (!seen.has(`${path}\0${value}`)) {
            stale.push(`${path}  ${value}`);
        }
    }
}

if (findings.length === 0 && stale.length === 0) {
    process.exit(0);
}

if (findings.length > 0) {
    console.error(
        `${findings.length} Tailwind ${findings.length === 1 ? `class hard-codes` : `classes hard-code`} a colour or a pixel size instead of using the theme.\n` +
            `The scale is in _editor/ui/src/styles/tokens.css (and _site/site/src/styles/global.css for the site):\n` +
            `--color-* for a palette entry, --spacing (0.25rem steps) for a size, --radius-* and --text-* for the rest.\n`,
    );
    for (const { at, found } of findings) {
        console.error(`  ${at}  ${found}`);
    }
    console.error(
        `\nIf the value has an exact token, use it. If it is CLOSE to one but not equal, do not round it —\n` +
            `that is a visual change, and it needs an owner rather than a refactor. If it genuinely has no token\n` +
            `and should, say the theme is missing an entry instead of spelling the value again. If it is none of\n` +
            `those, add it to ALLOWED in _tools/checks/tailwind-bypass.mjs with the reason, keyed by the class.`,
    );
}

if (stale.length > 0) {
    console.error(
        `\n${stale.length} entr${stale.length === 1 ? `y` : `ies`} in ALLOWED no longer appear${stale.length === 1 ? `s` : ``} in the file. Delete ${stale.length === 1 ? `it` : `them`} —\n` +
            `an exception that outlives the code it excused is how the list stops being read.\n`,
    );
    for (const line of stale) {
        console.error(`  ${line}`);
    }
}

process.exit(1);
