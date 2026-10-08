#!/usr/bin/env node
// The app has one tone vocabulary (_editor/ui/src/lib/tone.ts), and a tone at a strength is spelled only there. Refuses
// a status colour with an opacity written anywhere else in the editor or a first-party extension: `bg-danger/10`,
// `border-warning/40`, `hover:bg-success/15`, `decoration-danger/70`. Before the kit had one, 147 of them in 78 files
// came to seven fill strengths and six rim strengths, so two boxes that both meant "danger" rarely agreed on how
// loudly. A plain ink (`text-danger`) or a solid fill (`bg-warning`) is a token, not a strength, and is not this
// gate's business.
//
// The fix is a name, not a number: `toneTint(tone, "strong" | "soft")` for a tinted box's colours, `toneWash(tone)`
// for a pill, `toneHover(tone)` for a control that turns the tone under the pointer, `diffMark(mark)` for a diff, or
// <Notice>/<StatusBadge>, which already wear them. Exceptions live in ALLOWED, keyed by file and exact token.
import { readFileSync } from "node:fs";
import { finishFindings, waiverList } from "./lib/templates.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";

/** A status colour at an opacity, behind any variant prefixes. */
const TINT =
    /(?<![\w-])(?:[\w@[\]&>*:/-]+:)?!?(?:bg|border(?:-[xytblrse])?|ring|outline|decoration|from|via|to|shadow|fill|stroke|text|divide)-(?:success|warning|danger|info)\/\d+(?![\w/])/gu;

/** The one file allowed to spell a strength. */
const HOME = `_editor/ui/src/lib/tone.ts`;

// Waivers keyed by path then exact token, with the reason this strength is the component's own rather than a tone's.
const ALLOWED = new Map([
    [
        `_editor/ui/src/components/charts/Meter.vue`,
        new Map([
            [
                `bg-warning/15`,
                `A METER'S TRACK, not a tint: the room left under a fill, a lighter step of the fill's own colour. Every tone of meter steps its track down the same way (\`bg-primary-600/15\` beside it), so the number is the meter's geometry of light, read against its fill, and a box's tint strength would be the wrong one.`,
            ],
        ]),
    ],
    [
        `_editor/web/src/features/chat/session/usageStatus.ts`,
        new Map([
            [
                `bg-danger/25`,
                `A SPENT POOL'S METER TRACK (UsageMeter, ChatCapacityLane): the same kind of track as Meter.vue's, read against an empty fill, and it has to stand apart from the neutral \`bg-content/10\` track beside it — at a tint's /10 the two would be the same grey-pink.`,
            ],
        ]),
    ],
]);

const tracked = subjectFiles(`_editor`, `_extensions`).filter(
    (path) => /\.(?:vue|ts|mts)$/u.test(path) && path !== HOME && !/\.(?:test|spec)\.ts$/u.test(path) && !path.includes(`/dist/`),
);
const findings = [];
const { waived, stale } = waiverList(ALLOWED, `tone-tiers.mjs`);

for (const path of tracked) {
    const source = readFileSync(`${root}/${path}`, `utf8`);
    // Comments name these tokens to explain them; only code and markup count.
    const code = source
        .replace(/<!--[\s\S]*?-->/gu, (m) => m.replace(/[^\n]/gu, ` `))
        .replace(/(^|[^:\\])\/\/[^\n]*/gu, (m, lead) => lead + ` `.repeat(m.length - lead.length));
    for (const match of code.matchAll(TINT)) {
        const token = match[0];
        if (waived(path, token)) {
            continue;
        }
        const line = code.slice(0, match.index).split(`\n`).length;
        findings.push({
            at: `${path}:${line}`,
            why: `\`${token}\` writes a tone at a strength by hand: name it instead — \`toneTint(tone, "strong" | "soft")\` for a tinted box, \`toneWash(tone)\` for a pill, \`toneHover(tone)\` for a control that turns the tone under the pointer, \`diffMark(mark)\` for a diff, or <Notice>/<StatusBadge>, which wear them already (_editor/ui/src/lib/tone.ts)`,
        });
    }
}

findings.push(...stale());

finishFindings(
    findings,
    `with tone tiers. A tone at a strength is named in tone.ts, never written as an opacity.`,
    `${tracked.length} files: every tinted status colour comes from tone.ts`,
);
