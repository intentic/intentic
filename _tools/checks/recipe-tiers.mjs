#!/usr/bin/env node
// The kit's class recipes (_editor/ui/src/lib/ui.ts) name what they vary: a size, a tone, a state. A call site picks
// the variant and passes LAYOUT only (a margin, `shrink-0`, `self-start`, a position, a hover-reveal), so this refuses:
// 1. a class a recipe has a variant for, passed as an override — `ui.iconButton("h-8 w-8")` is `{ size: "lg" }`,
//    `ui.textButton("text-2xs text-muted hover:text-content")` is `{ size: "xs", tone: "quiet" }`. Before the
//    variants, 440 of 679 recipe calls passed overrides and the commonest were these, each site its own spelling.
// 2. a retired recipe name: `linkButton`/`textAction` are `textButton` (one control, two tones, which call sites had
//    already been turning into each other by override), `inputSm`/`inputInline`/`sectionLabelSm` are the size variant.
//    They stay in the kit only because installed extensions call them through the host.
// 3. `ui-chip-on` written by hand: the lit chip is `ui.chip({ on })`.
// Exceptions live in ALLOWED, keyed by file and exact token, with the reason the geometry is the place's own.
import { readFileSync } from "node:fs";
import { finishFindings, waiverList } from "./lib/templates.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";

// The variant prefixes a token may carry (`hover:`, `max-md:`, `group-hover/row:`), stripped before judging.
const bare = (token) =>
    token
        .replace(/^!/u, ``)
        .replace(/^(?:[\w@[\]&>*/-]+:)+/u, ``)
        .replace(/^!/u, ``);
const prefix = (token) => token.slice(0, token.length - bare(token).length);

/** What each recipe owns, as rules over one class token: the variant to use instead. */
const OWNS = {
    iconButton: [
        {
            test: (t) => /^(?:h|w|size)-(?:\d|auto|px|full|fit|\[)/u.test(bare(t)),
            say: `the box is the size variant: \`{ size: "xs" | "sm" | "md" | "lg" | "xl" }\` (20, 24, 28, 32, 40px)`,
        },
        { test: (t) => /^rounded(?:-|$)/u.test(bare(t)), say: `the radius follows the size variant; a circle is \`{ round: true }\`` },
        {
            test: (t) => /^text-(?:muted|subtle|content|danger)$/u.test(bare(t)) || /^bg-(?:overlay|danger\/\d+)$/u.test(bare(t)),
            say: `ink and fill are the tone and state variants: \`{ tone: "muted" | "subtle" | "danger" }\`, \`{ on: true }\` for pressed`,
        },
    ],
    textButton: [
        {
            test: (t) => prefix(t) === `` && /^text-(?:2xs|xs|sm)$/u.test(bare(t)),
            say: `the type size is the size variant: \`{ size: "xs" | "sm" }\``,
        },
        { test: (t) => /^gap-/u.test(bare(t)), say: `the gap to an icon steps with the size variant` },
        {
            test: (t) => /^text-(?:muted|subtle|content|link|danger)$/u.test(bare(t)) || /^(?:no-)?underline$/u.test(bare(t)),
            say: `ink and underline are the tone variant: \`{ tone: "link" | "quiet" | "subtle" | "danger" }\``,
        },
        { test: (t) => t === `my-0` || t === `min-h-0`, say: `sitting inside a line of text is \`{ flush: true }\`` },
    ],
    sectionLabel: [
        {
            test: (t) => prefix(t) === `` && /^text-(?:2xs|xs|sm)$/u.test(bare(t)),
            say: `the type size is the size variant: \`{ size: "sm" | "xs" }\``,
        },
        {
            test: (t) => prefix(t) === `` && /^text-(?:muted|subtle|content|danger|warning|success)$/u.test(bare(t)),
            say: `the ink is the tone variant: \`{ tone: "neutral" | "danger" | "warning" | "success" }\``,
        },
    ],
};

const RETIRED = {
    linkButton: `\`ui.textButton()\` (tone \`link\`, the default)`,
    textAction: `\`ui.textButton({ tone: "quiet" })\``,
    inputSm: `\`ui.input({ size: "sm" })\``,
    inputInline: `\`ui.input({ size: "inline" })\``,
    sectionLabelSm: `\`ui.sectionLabel({ size: "xs" })\``,
};

// Waivers keyed by path then exact token (or `ui.<name>` for a retired name), with the reason.
const ALLOWED = new Map([
    [
        `_editor/ui/src/components/primitives/ImageView.vue`,
        new Map([
            [
                `w-auto`,
                `"FIT" AND "1:1" ARE WORDS in the zoom bar's row of xs glyphs: they keep the row's 20px height and its hover plate, and the box widens to the word. A chip or a text button would put a second control shape in a five-button bar.`,
            ],
        ]),
    ],
    [
        `_editor/web/src/features/capabilities/connect/secrets/SecretEntryRow.vue`,
        new Map([
            [
                `text-danger`,
                `THE ARMED SECOND PRESS of a two-step remove, beside a neutral cancel: red before the pointer reaches it is what says this one deletes. The danger tone is neutral at rest, which is right for a first press and wrong for the confirmation of one.`,
            ],
        ]),
    ],
    [
        `_editor/web/src/features/sandbox/overview/SandboxOverview.vue`,
        new Map([
            [
                `h-12`,
                `THE OVERVIEW HEADING'S 48px SANDBOX LOGO is the button: its box is the logo's (SandboxLogo :size="48"), drawn nowhere else, not a glyph at any of the recipe's sizes.`,
            ],
            [`w-12`, `The same logo-as-button: its width is the logo's.`],
        ]),
    ],
    [
        `_editor/web/src/features/sandbox/secrets/ConnectFlow.vue`,
        new Map([
            [
                `w-auto`,
                `A COPY GLYPH THAT SAYS "COPIED" for a beat after the press: while the word shows, the box is the word's width, then it is the glyph's square again.`,
            ],
        ]),
    ],
]);

const HOME = new Set([`_editor/ui/src/lib/ui.ts`]);
const tracked = subjectFiles(`_editor`, `_extensions`).filter(
    (path) => /\.(?:vue|ts|mts)$/u.test(path) && !HOME.has(path) && !/\.(?:test|spec)\.ts$/u.test(path) && !path.includes(`/dist/`),
);
const findings = [];
const { waived, stale } = waiverList(ALLOWED, `recipe-tiers.mjs`);

// The balanced argument list after `ui.name(`, as written; a recipe call never spans an unbalanced string.
const argsAt = (code, open) => {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        const c = code[i];
        if (c === `(`) depth++;
        else if (c === `)` && --depth === 0) return code.slice(open + 1, i);
    }
    return ``;
};

// Every class word written inside the arguments' string literals, template literals included; an object literal's
// keys and values (`{ size: "lg" }`) are variants, not classes, so a `{…}` is skipped whole.
const classWords = (args) => {
    const withoutObjects = args.replace(/\{[^{}]*\}/gu, ` `);
    return [...withoutObjects.matchAll(/`([^`]*)`|'([^']*)'|"([^"]*)"/gu)]
        .flatMap((m) => (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/gu, ` `).split(/\s+/u))
        .filter((word) => /^[!a-z@[]/u.test(word));
};

for (const path of tracked) {
    const source = readFileSync(`${root}/${path}`, `utf8`);
    const code = source
        .replace(/<!--[\s\S]*?-->/gu, (m) => m.replace(/[^\n]/gu, ` `))
        .replace(/(^|[^:\\])\/\/[^\n]*/gu, (m, lead) => lead + ` `.repeat(m.length - lead.length));
    const lineOf = (index) => `${path}:${code.slice(0, index).split(`\n`).length}`;

    for (const call of code.matchAll(/\bui\.(\w+)\s*\(/gu)) {
        const name = call[1];
        if (name in RETIRED && !waived(path, `ui.${name}`)) {
            findings.push({ at: lineOf(call.index), why: `\`ui.${name}()\` is retired in this repository: use ${RETIRED[name]}` });
        }
        const owner = name === `linkButton` || name === `textAction` ? `textButton` : name === `sectionLabelSm` ? `sectionLabel` : name;
        const rules = OWNS[owner];
        if (rules === undefined) {
            continue;
        }
        for (const word of classWords(argsAt(code, call.index + call[0].length - 1))) {
            const rule = rules.find((r) => r.test(word));
            if (rule !== undefined && !waived(path, word)) {
                findings.push({ at: lineOf(call.index), why: `\`${word}\` overrides what \`ui.${owner}()\` owns: ${rule.say}; pass layout only` });
            }
        }
    }

    for (const lit of code.matchAll(/(?<![\w-])ui-chip-on(?![\w-])/gu)) {
        if (!waived(path, `ui-chip-on`)) {
            findings.push({
                at: lineOf(lit.index),
                why: `\`ui-chip-on\` written by hand: the lit chip is \`ui.chip({ on: selected })\`, so its state is a variant rather than a ternary per call site`,
            });
        }
    }
}

findings.push(...stale());

finishFindings(
    findings,
    `with recipe tiers. A recipe's variant is chosen by name; a call site passes layout only.`,
    `${tracked.length} files: every recipe call picks its variants by name`,
);
