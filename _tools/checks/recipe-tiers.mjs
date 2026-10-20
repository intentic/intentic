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
// 4. A selection marked a second way: `ui-row-select-on` with a rule, ring or fill of its own beside it, or a hand tint
//    (`bg-link/10`, `bg-primary-600/15`) put on what is selected. The one selected mark is `ui-row-select-on` (or
//    `<Row selected>`, `ui.chip({ on })`), so /sandbox/models and /sandbox/personas cannot mark a pick two ways again.
// 5. `ui.sectionLabel()` outside the kit: the section header is <SectionHeader> (drawn by <Section>, <RowGroup> and
//    <NavRail>), which owns its size, its spacing and what may sit beside it; the recipe stays for installed extensions.
// 6. A chip or a status pill given its own box: a padding, a height, a gap, a type size, a line height or a radius on a
//    `ui.chip()`, a `ui-chip` or a `ui-status-pill`. Their sizes are decided once (utilities.css): the chip's
//    `{ size: "sm" | "md" | "lg" }` with `{ lead }`/`{ trail }`, the pill's `-inline`/`-md`. ~60 call sites had each
//    spelled one, the "Show fewer" chip at a lane's tail among them.
// Exceptions: `allow(recipes): <reason>` at the site, saying why the geometry is the place's own.
import { readFileSync } from "node:fs";
import { boxOverrides } from "../../_shared/extension-ui/check/kit-decisions.mjs";
import { blank, classWordsOf, excusedAt, finishFindings, tags } from "./lib/templates.mjs";
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

// Rule 6: what a chip's or a pill's size owns (lib/kit-decisions.mjs's `boxOverrides`, where its tests read it).
const CHIP_SAYS = `the chip's box is its size variant: \`ui.chip({ size: "sm" | "md" | "lg" })\` (20, 26, 32px), with \`{ lead: true }\` when it opens on a mark and \`{ trail: true }\` when it ends in its own ×`;
const PILL_SAYS = `the pill's box is the kit's: \`ui-status-pill\` (20px), \`ui-status-pill-md\` (24px), \`ui-status-pill-inline\` (16px, inside a line of text)`;
OWNS.chip = [{ test: (t) => boxOverrides(`ui-chip ${t}`).words.length > 0, say: CHIP_SAYS }];

const RETIRED = {
    linkButton: `\`ui.textButton()\` (tone \`link\`, the default)`,
    textAction: `\`ui.textButton({ tone: "quiet" })\``,
    inputSm: `\`ui.input({ size: "sm" })\``,
    inputInline: `\`ui.input({ size: "inline" })\``,
    sectionLabelSm: `<SectionHeader density="dense"> (_editor/ui/src/components/rows/SectionHeader.vue)`,
    sectionLabel: `<Section :label> over what it heads, <RowGroup :label> over rows, or <SectionHeader> for the header alone (_editor/ui/src/components/rows/): the header's size, spacing and neighbours are the kit's`,
};

const HOME = new Set([`_editor/ui/src/lib/ui.ts`, `_editor/ui/src/components/rows/SectionHeader.vue`]);

// Rule 4. A colour of its own on a selected thing: a rule, a ring or a fill.
const SELECTION_EXTRA = /(?:^|\s)(?:[\w@-]+:)*(?:border-(?:primary|link|accent)|ring(?:-\d)?(?:\s|$)|ring-(?:primary|link|accent)|bg-(?:primary|link|accent))[\w./-]*/u;
// A hand tint of the selection's own hue.
const HAND_TINT = /(?:^|[\s`'"])bg-(?:link|primary-\d{3})\/\d+(?=[\s`'"]|$)/u;
// What a condition reads like when it decides that a thing is the picked one.
const PICKED = /select|pick|chosen|active|current/iu;
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

    // Rule 4: within one class literal, the selected mark and a second colour beside it.
    for (const lit of code.matchAll(/`([^`]*)`|'([^'\n]*)'|"([^"\n]*)"/gu)) {
        const words = lit[1] ?? lit[2] ?? lit[3] ?? ``;
        if (/(?:^|\s)ui-row-select-on(?:\s|$)/u.test(words) && SELECTION_EXTRA.test(words.replace(/(?:^|\s)ui-row-select-on(?=\s|$)/u, ` `)) && !excused(lit.index)) {
            findings.push({
                at: lineOf(lit.index),
                why: `\`${words.trim()}\` marks a selection twice: \`ui-row-select-on\` is the whole selected mark, in every skin, so a rule, ring or fill beside it is a second one`,
            });
        }
    }
    // Rule 4: a tint of the selection's hue, put on whatever a picked-sounding condition chooses (ternary or object).
    // A bound attribute's own quotes are markup, not a string: read the expression inside them, or `:class="{ 'x': on }"`
    // is one literal and the tint in it is never seen.
    const bound = code.replace(/(\s(?::|v-bind:)[\w.-]+=)"([^"]*)"/gu, (_, name, value) => `${name} ${value} `);
    const picks = [
        ...bound.matchAll(/([^?:{},\n]*)\?\s*(`[^`]*`|'[^'\n]*'|"[^"\n]*")/gu),
        ...bound.matchAll(/(`[^`]*`|'[^'\n]*'|"[^"\n]*")[ \t]*:[ \t]*([^,}\n]*)/gu),
    ];
    for (const pick of picks) {
        const [condition, literal] = pick[0].trimStart().startsWith(pick[1]) && /\?/u.test(pick[0]) ? [pick[1], pick[2]] : [pick[2], pick[1]];
        if (PICKED.test(condition ?? ``) && HAND_TINT.test(literal ?? ``) && !excused(pick.index)) {
            findings.push({
                at: lineOf(pick.index),
                why: `a picked thing tinted by hand (\`${(literal ?? ``).replace(/[`'"]/gu, ``).trim()}\`): the selected mark is \`ui-row-select-on\` (or \`<Row selected>\`, \`ui.chip({ on })\`)`,
            });
        }
    }

    // Rule 6: a chip's or a pill's box restated, in one class literal or across one tag's `class` and `:class`.
    const boxed = new Set();
    const boxFinding = (index, words) => {
        const { kind, words: restated } = boxOverrides(words);
        for (const word of restated) {
            const where = lineOf(index);
            if (!boxed.has(`${where} ${word}`) && !excused(index)) {
                boxed.add(`${where} ${word}`);
                findings.push({ at: where, why: `\`${word}\` on a ${kind} restates its box: ${kind === `chip` ? CHIP_SAYS : PILL_SAYS}; pass layout only` });
            }
        }
    };
    // In an SFC the literal pass reads the script only; its markup is the tag pass's, which sees a tag whole.
    const scripted = scan === undefined ? code : code.replace(/(^|<\/script>)([\s\S]*?)(<script\b|$)/gu, (_, open, between, close) => open + between.replace(/[^\n]/gu, ` `) + close);
    for (const lit of scripted.matchAll(/`([^`]*)`|'([^'\n]*)'|"([^"\n]*)"/gu)) {
        const words = (lit[1] ?? lit[2] ?? lit[3] ?? ``).replace(/\$\{[^}]*\}/gu, ` `);
        boxFinding(lit.index, words);
    }
    if (scan !== undefined) {
        for (const { attrs, index } of tags(scan)) {
            // A `ui.chip(…)` call's own arguments are rule 1's; here, the words beside it on the same tag.
            boxFinding(index, classWordsOf(attrs));
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
