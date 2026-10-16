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
// Exceptions: `allow(recipes): <reason>` at the site, saying why the geometry is the place's own.
import { readFileSync } from "node:fs";
import { blank, excusedAt, finishFindings } from "./lib/templates.mjs";
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
        { test: (t) => bare(t).startsWith('gap-'), say: `the gap to an icon steps with the size variant` },
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

const HOME = new Set([`_editor/ui/src/lib/ui.ts`]);
const tracked = subjectFiles(`_editor`, `_extensions`).filter(
    (path) => /\.(?:vue|ts|mts)$/u.test(path) && !HOME.has(path) && !/\.(?:test|spec)\.ts$/u.test(path) && !path.includes(`/dist/`),
);
const findings = [];

// The balanced argument list after `ui.name(`, as written; a recipe call never spans an unbalanced string.
const argsAt = (code, open) => {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        const c = code[i];
        if (c === `(`) {depth++;}
        else if (c === `)` && --depth === 0) {return code.slice(open + 1, i);}
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
    const scan = path.endsWith(`.vue`) ? blank(source) : undefined;
    const excused = (index) => excusedAt(source, scan, index, `recipes`);

    for (const call of code.matchAll(/\bui\.(\w+)\s*\(/gu)) {
        const name = call[1];
        if (name in RETIRED && !excused(call.index)) {
            findings.push({ at: lineOf(call.index), why: `\`ui.${name}()\` is retired in this repository: use ${RETIRED[name]}` });
        }
        const owner = name === `linkButton` || name === `textAction` ? `textButton` : name === `sectionLabelSm` ? `sectionLabel` : name;
        const rules = OWNS[owner];
        if (rules === undefined) {
            continue;
        }
        for (const word of classWords(argsAt(code, call.index + call[0].length - 1))) {
            const rule = rules.find((r) => r.test(word));
            if (rule !== undefined && !excused(call.index)) {
                findings.push({ at: lineOf(call.index), why: `\`${word}\` overrides what \`ui.${owner}()\` owns: ${rule.say}; pass layout only` });
            }
        }
    }

    for (const lit of code.matchAll(/(?<![\w-])ui-chip-on(?![\w-])/gu)) {
        if (!excused(lit.index)) {
            findings.push({
                at: lineOf(lit.index),
                why: `\`ui-chip-on\` written by hand: the lit chip is \`ui.chip({ on: selected })\`, so its state is a variant rather than a ternary per call site`,
            });
        }
    }
}

finishFindings(
    findings,
    `with recipe tiers. A recipe's variant is chosen by name; a call site passes layout only.`,
    `${tracked.length} files: every recipe call picks its variants by name`,
);
