#!/usr/bin/env node
// Blocks a Tailwind arbitrary value (a hard-coded color or pixel size) in a class attribute, in place of the theme's
// `--color-*`/`--spacing` scale. Only inside a class attribute, in markup an oxlint plugin can't reach past a .vue's
// <script> or an .astro's frontmatter; TypeScript class strings are covered too. Exceptions live in ALLOWED, keyed by
// file and class.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "../constants/src/node.mjs";

const root = repoRoot(import.meta.url);

// Mirrors MARKUP_GLOBS in stack.ts, so the probe and this gate agree on what counts as markup.
const MARKUP = /\.(?:vue|tsx|jsx|html|svelte|astro)$/u;

// Class lists written as a string, in the design kit itself: a bypass here is inherited by every call site.
const SCRIPT = /\.(?:ts|mts|cts)$/u;

// Mirrors BYPASS_PATTERN in stack.ts, capturing the value so the report and ALLOWED can name the whole class.
const BYPASS = /[\w-]*-\[(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\(|[0-9]+(?:\.[0-9]+)?px)[^\]]*\]/gu;

// Every framework's class attribute in one expression; a lookbehind stops `:class` matching twice.
const CLASS_ATTR = /(?<![\w:-])(?:(?::|v-bind:)?class(?::list)?|className)\s*=\s*/gu;

// The two remaining entries are numbers computed from the geometry around them, not a step on any scale; a token would
// misname them, so the derivation is written out beside the value instead.
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
        `_editor/web/src/features/workspace/changes/ReviewPanel.vue`,
        new Map([
            [
                `max-h-[142px]`,
                `eight rows exactly: 8 x 16.5px (text-xs at leading-snug) + 8px of py-1 + the 2px border. max-h-36 (144px) would add a 2px sliver of a ninth row under the eighth, which is the visual bug this number was picked to avoid.`,
            ],
        ]),
    ],
]);

/** Index of the brace closing the one at `start`; counts depth, since a JSX/Astro expression can nest another. */
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

/**
 * Every class-attribute value in a file as `{ value, offset }`. Scans the whole text, not line by line, since a
 * `:class="[...]"` binding can span several lines.
 */
const classValues = (text) => {
    const found = [];
    CLASS_ATTR.lastIndex = 0;
    for (let match = CLASS_ATTR.exec(text); match !== null; match = CLASS_ATTR.exec(text)) {
        const start = match.index + match[0].length;
        const open = text[start];
        const quoted = open === `"` || open === `'` || open === `\``;
        // -1 covers an unquoted or unterminated attribute; an unparseable file has a louder problem than a colour.
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

/**
 * A comment line, so the pattern's own documentation (stack.ts's `bg-[#3b82f6]`, extensionSurface.test.ts's `w-[37px]`)
 * isn't reported as a violation of itself.
 */
const isComment = (line) => {
    const start = line.trim();
    return start.startsWith(`*`) || start.startsWith(`//`) || start.startsWith(`/*`);
};

/** Each line as `{ value, offset }`, so a script file scans with the same machinery as an attribute. */
const lineSpans = (text) => {
    const spans = [];
    let offset = 0;
    for (const line of text.split(`\n`)) {
        spans.push({ value: line, offset });
        offset += line.length + 1;
    }
    return spans;
};

/**
 * In markup, a class lives only in an attribute, so that's the unit; in TypeScript there's no attribute to anchor on,
 * so the unit is the line, with comments dropped by hand.
 */
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
