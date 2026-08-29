#!/usr/bin/env node
/* EVERY LIST IN THIS APP IS ONE SIZE, AND THIS IS THE GATE THAT KEEPS IT.
 *
 * <Row>, <DisclosureRow> and <SkeletonRows> draw from one table of three tiers (_editor/ui/src/components/row.ts),
 * and the tier is the <RowGroup>'s: a group is a list, a list is `compact`, and no call site says anything. That
 * is the second version of this rule. The first one kept the old taxonomy — "comfortable for settings rows,
 * compact for record lists" — and merely made it inheritable, which fixed the mechanism and left the JUDGEMENT
 * to drift exactly as before. Measured across the build at that point: 51 groups compact, 33 comfortable, and
 * all 33 of those had never stated a tier at all. Not one group in the app had ever chosen it on purpose.
 *
 * WHAT THAT LOOKED LIKE, which is how it was reported: the Sandbox hub changed row language as you tabbed
 * through it. Personas, Extensions, Environment and Access drew their titles at 14px/500; Agent, Status and
 * Computers drew theirs at 16px/600 with a 18px glyph against a 14px one. Settings did the same — Keybindings
 * against Appearance, Notifications and Data. Agent contradicted itself inside one tab: Skills and Rules
 * compact, Models and Instructions not. The taxonomy was never decidable ("Models" is three rows with a picker;
 * "Computers" is machines with switches), so it was decided by whoever edited the file last.
 *
 * The other three families the first pass fixed, kept here because they are the ways the size can still drift:
 *
 *   · a row's lead mark was a number typed at the call site — 22 on three lists, 20 on two, 24 on a sixth, 32
 *     on a seventh, all of them meaning "a mark on a record row";
 *   · 58 lines that live on a group's surface without being rows (an empty state, a sentence, an "add one", a
 *     form) picked their own padding, in six spellings, four of which matched no tier at all;
 *   · outlines promised one height and landed another, so lists visibly jumped as they arrived.
 *
 * WHAT THIS REFUSES:
 *
 *   1. A DIRECT CHILD OF A <RowGroup> THAT SETS ITS OWN PADDING. It is sharing a surface with rows drawn from
 *      the tier table, so a hand-picked `px-4 py-3` is a line that sits a few pixels off them for good. Use
 *      <RowNote> (`note` / `empty` / `action` / `block`), which reads the group's tier.
 *   2. A ROW INSIDE A <RowGroup> THAT DECLARES ITS OWN `density`. The group already said it; a second answer is
 *      either redundant or a disagreement nobody can see from the group's own markup. `flush` rows are exempt:
 *      a card masthead outranks the rows under it and is comfortable by RANK rather than by list.
 *   3. A <RowGroup> THAT RESTATES THE DEFAULT (`density="compact"`). A group IS compact; writing it down invites
 *      the next reader to wonder when it should be omitted, which is the doorway the taxonomy came in through.
 *   4. A LITERAL `:size` ON A MARK INSIDE `#lead`. <Row> and <DisclosureRow> hand the tier's mark size to that
 *      slot — `<template #lead="{ mark }">` — so there is nothing left to type, and typing it is how 20/22/24/32
 *      happened. Marks elsewhere on a row (a `#meta` cluster of platform logos) are not this and are not checked:
 *      they are facts beside the name, deliberately a notch under it.
 *   5. A ROW COMPONENT USED OUTSIDE A <RowGroup>. A `*Row.vue` whose own root takes no `density` is relying on
 *      the group to supply one; mounted anywhere else it silently falls back to `comfortable`, which is the
 *      original bug wearing the new mechanism. Either put it in a group or pass `density` at the usage.
 *
 * A group that genuinely needs another tier may still say so — rule 3 only refuses the one that says `compact`,
 * which is what it already is. That leaves the exception possible and visible, and makes not-thinking land on
 * the answer every other list in the app gives. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "@intentic/constants/node";

const root = repoRoot(import.meta.url);

// Any Tailwind padding utility, at any breakpoint. `p-0`/`py-0` are a deliberate reset, not a geometry choice.
const PADDING = /(?:^|\s)(?:sm:|md:|lg:|xl:|2xl:|@\w+:|max-\w+:)?(?:p|px|py|pt|pb|pl|pr)-(?!0(?:\s|$))[\w.[\]/-]+/;
// The components that read the tier, plus the app's own `*Row` components, which wrap one of them.
const ROW_LIKE = (name) => name === `Row` || name === `DisclosureRow` || name === `SkeletonRows` || name === `RowNote` || /.Row$/.test(name);
const MARKS = new Set([`BrandMark`, `Avatar`, `PersonaFace`]);
// Elements that carry no geometry of their own and so pass a group's tier through to what they contain.
const VOID = new Set([`br`, `hr`, `img`, `input`, `source`]);

const tracked = execFileSync(`git`, [`ls-files`, `-z`, `_editor/web/src`, `_editor/ui/src`, `_editor/extension-ui/src`], {
    cwd: root,
    encoding: `utf8`,
    maxBuffer: 64 * 1024 * 1024,
})
    .split(`\0`)
    .filter((path) => path.endsWith(`.vue`));

/* THE TEMPLATE, AND ONLY THE TEMPLATE, with everything else BLANKED rather than stripped: every newline is
 * kept, so a line number computed off the result is the line number in the file.
 *
 * Three things go, and each of them produced a finding before it did. The `<script>` block, because this repo's
 * design notes are long block comments full of markup — "`<SkillRow>` opens an editable skill" in a paragraph is
 * not a usage, and reported as one it sends a reader to a line with no component on it. The `<style>` block, for
 * the same reason in CSS. And the template's own `<!-- -->` notes, which are where every argument in these files
 * actually lives and are thick with example tags. */
const blanked = (m) => m.replace(/[^\n]/gu, ` `);
const blank = (source) =>
    source
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, blanked)
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gu, blanked)
        .replace(/<!--[\s\S]*?-->/gu, blanked);

/* A tag walk, not a parser. Attribute values are consumed as units so a `>` inside `:style="{...}"` or a
 * template literal cannot end a tag early, which is the one way a regex walk of this markup goes wrong. */
const TAG = /<(\/?)([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|`[^`]*`|[^>"'`])*?)(\/?)>/gu;

const findings = [];
const at = (path, source, index) => `${path}:${source.slice(0, index).split(`\n`).length}`;
/** Both `class="…"` and `:class="…"`, joined: a padding hidden in a bound class is the same padding. */
const classesOf = (attrs) => [...attrs.matchAll(/:?class="([^"]*)"/gu)].map((m) => m[1]).join(` `);

// Which components are "a row that expects a group to size it": root is a bare <Row>/<DisclosureRow>, no density.
const inheritingRows = new Set();
// Where each component is used, and whether that usage had a <RowGroup> above it.
const usages = new Map();

for (const path of tracked) {
    const source = readFileSync(`${root}/${path}`, `utf8`);
    const scan = blank(source);
    const stack = [];
    /* <template v-if>/<template v-for> draw nothing, so a row inside one is still the group's child. A
     * <template #slot> is the opposite: it is somebody else's content, and its own component owns what is in it. */
    const parent = () => stack.findLast((frame) => !frame.transparent);
    const inGroup = () => stack.some((frame) => frame.name === `RowGroup`);
    const inLead = () => stack.some((frame) => frame.lead);

    let match;
    TAG.lastIndex = 0;
    while ((match = TAG.exec(scan)) !== null) {
        const [, closing, name, attrs, selfClosing] = match;
        if (closing !== ``) {
            const open = stack.findLastIndex((frame) => frame.name === name);
            if (open !== -1) {
                stack.length = open;
            }
            continue;
        }
        const namedSlot = name === `template` && /(?:^|\s)(?:#|v-slot)/u.test(attrs);
        const transparent = name === `template` && !namedSlot;
        const where = at(path, scan, match.index);

        // ── 1 · a padded line sharing a group's surface with rows drawn from the tier table
        if (parent()?.name === `RowGroup` && !namedSlot && !transparent && !ROW_LIKE(name) && PADDING.test(classesOf(attrs))) {
            findings.push({
                at: where,
                why: `<${name}> is a direct child of a <RowGroup> and sets its own padding, so it sits off the rows it shares a surface with: use <RowNote> (note / empty / action / block), which draws at the group's tier`,
            });
        }

        // ── 2 · a row answering a question its group already answered
        if (ROW_LIKE(name) && inGroup() && /(?:^|\s):?density="/u.test(attrs) && !/(?:^|\s)flush(?:[\s=>]|$)/u.test(attrs)) {
            findings.push({
                at: where,
                why: `<${name}> declares its own \`density\` inside a <RowGroup> that already publishes one: move the tier to the group, or keep it here only for a \`flush\` masthead, which outranks the rows under it`,
            });
        }

        /* ── 3 · a group restating what a group already is. Only `compact` is refused: another tier here is a
         * real, visible exception, and this rule exists to stop the DEFAULT being written down — which is what
         * reopens "so when do I leave it off?", and from there the taxonomy that split the app in two. */
        if (name === `RowGroup` && /(?:^|\s)density="compact"/u.test(attrs)) {
            findings.push({
                at: where,
                why: `<RowGroup density="compact"> restates the default: a group is a list and a list is compact, so drop the prop`,
            });
        }

        // ── 4 · a mark sized by hand where the tier is handing the size out
        if (MARKS.has(name) && inLead() && /(?:^|\s):size="\d+"/u.test(attrs)) {
            findings.push({
                at: where,
                why: `<${name}> in a row's #lead is sized with a literal: take the tier's own — \`<template #lead="{ mark }">\` then \`:size="mark"\` — so a list's marks cannot drift apart again`,
            });
        }

        // Where every non-native component is used, for rule 5 below.
        if (/^[A-Z]/u.test(name)) {
            (usages.get(name) ?? usages.set(name, []).get(name)).push({ at: where, inGroup: inGroup(), sized: /(?:^|\s):?density="/u.test(attrs) });
        }

        if (selfClosing === `` && !VOID.has(name)) {
            stack.push({ name, transparent, lead: namedSlot && /(?:#lead|v-slot:lead)/u.test(attrs) });
        }
    }

    /* Does THIS file define a row that leans on a group for its size? Its template's first element is the test:
     * a `*Row.vue` is one row, so its root is the <Row>/<DisclosureRow> in question. */
    const template = scan.indexOf(`<template>`);
    if (template !== -1) {
        TAG.lastIndex = template + `<template>`.length;
        const first = TAG.exec(scan);
        if (first !== null && (first[2] === `Row` || first[2] === `DisclosureRow`) && !/(?:^|\s):?density="/u.test(first[3])) {
            inheritingRows.add(
                path
                    .split(`/`)
                    .at(-1)
                    .replace(/\.vue$/u, ``),
            );
        }
    }
}

// ── 5 · a row that expects a group's tier, mounted where there is no group to read it from
for (const component of inheritingRows) {
    for (const usage of usages.get(component) ?? []) {
        if (!usage.inGroup && !usage.sized) {
            findings.push({
                at: usage.at,
                why: `<${component}> takes its tier from the <RowGroup> around it and there is none here, so it falls back to \`comfortable\`: put it in a group, or pass \`density\` at this usage`,
            });
        }
    }
}

if (findings.length > 0) {
    for (const { at: where, why } of findings.toSorted((a, b) => a.at.localeCompare(b.at))) {
        console.error(`${where}  ${why}`);
    }
    console.error(`\n${findings.length} problem(s) with row tiers. A list's size is the list's answer, given once on its <RowGroup>.`);
    process.exit(1);
}

console.log(`${tracked.length} templates: every row, outline and note takes its size from the group it is on`);
