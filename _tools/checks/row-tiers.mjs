#!/usr/bin/env node
// Every list and section draws from one tier table (_editor/ui/src/components/rows/row.ts) through the kit's own
// primitives: rows through <RowGroup>, a header through <SectionHeader> (which <RowGroup>, <Section> and <NavRail> draw).
// A group is a list and a list is `compact`, with no call site stating otherwise; a header carries no count, no caption
// and no fill, and whether a group draws a card is decided by what it lies on (overlays/surfaceGround.ts), never by it.
// Refuses:
// 1 a <RowGroup> child that sets its own padding — use <RowNote> instead
// 2 a row inside a <RowGroup> that declares its own `density` (flush rows excepted)
// 3 a <RowGroup> that restates the default `density="compact"`
// 4 a header decision taken at the call site: `count`, `caption` or `flat` on a <RowGroup>, `sticky-headings` on a
//   <NavRail> (each was a prop once, and each was removed view by view before it left the component)
// 5 a literal `:size` on a mark inside `#lead`, where the tier already hands one out
// 6 a row component (relying on its group for density) mounted outside any <RowGroup>
// 7 a section header drawn by hand: an `<h1>`–`<h6>` in the section label's look (uppercase, tracked)
// 8 a group among another group's rows, which nests one card in another: groups side by side are a stack
// 9 sections side by side with nothing spacing them: a parent holding two or more <RowGroup>/<Section>s states the gap
//   between them (`gap-*`, `space-y-*`), and a component whose template is several of them at its root is wrapped
// 10 a height on a row: a row is as tall as its tier makes it, and a settings group's one floor is `equal-rows`
// Rules 4 and 7–10 are lib/kit-decisions.mjs's `sectionFindings`, where their tests read them.
import { sectionFindings } from "./lib/kit-decisions.mjs";
import { at, blank, classesOf, finishFindings, tags, templateSource, templatesUnder, VOID } from "./lib/templates.mjs";

// Any Tailwind padding utility, at any breakpoint; `p-0`/`py-0` are a deliberate reset, not geometry.
const PADDING = /(?:^|\s)(?:sm:|md:|lg:|xl:|2xl:|@\w+:|max-\w+:)?(?:p|px|py|pt|pb|pl|pr)-(?!0(?:\s|$))[\w.[\]/-]+/;
// Components that read the tier, plus the app's own `*Row` components wrapping one of them.
const ROW_LIKE = (name) => name === `Row` || name === `DisclosureRow` || name === `SkeletonRows` || name === `RowNote` || /.Row$/.test(name);
const MARKS = new Set([`BrandMark`, `Avatar`, `PersonaFace`]);

// Every surface a view is drawn on: the web app, the desktop app, the kit, and every extension in this repository. The
// section rules (4, 7–10) hold on all of them; the tier rules (1–3, 5, 6) hold on the editor's own surfaces, where they
// were introduced, and reach the extensions as their own rows are redrawn.
const tracked = templatesUnder(`_editor/web/src`, `_editor/desktop-app/src`, `_editor/ui/src`, `_shared/extension-ui/src`, `_extensions`);
const TIERED = /^(?:_editor\/(?:web|desktop-app|ui)\/src|_shared\/extension-ui\/src)\//u;
const findings = [];

// Components whose root is a bare <Row>/<DisclosureRow> with no density: they expect a group to size them.
const inheritingRows = new Set();
// Where each component is used, and whether that usage sat under a <RowGroup>.
const usages = new Map();

for (const path of tracked) {
    const scan = blank(templateSource(path));
    findings.push(...sectionFindings(path, scan));
    if (!TIERED.test(path)) {
        continue;
    }
    const stack = [];
    // `<template v-if>`/`v-for` draw nothing, so a row inside one is still the group's child; `<template #slot>` is
    // somebody else's content, owned by its own component.
    const parent = () => stack.findLast((frame) => !frame.transparent);
    const inGroup = () => stack.some((frame) => frame.name === `RowGroup`);
    const inLead = () => stack.some((frame) => frame.lead);

    for (const { closing, name, attrs, selfClosing, index } of tags(scan)) {
        if (closing !== ``) {
            const open = stack.findLastIndex((frame) => frame.name === name);
            if (open !== -1) {
                stack.length = open;
            }
            continue;
        }
        const namedSlot = name === `template` && /(?:^|\s)(?:#|v-slot)/u.test(attrs);
        const transparent = name === `template` && !namedSlot;
        const where = at(path, scan, index);

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

        // Only `compact` is refused: another tier here is a real, visible exception, and this only stops the default
        // from being written down.
        if (name === `RowGroup` && /(?:^|\s)density="compact"/u.test(attrs)) {
            findings.push({
                at: where,
                why: `<RowGroup density="compact"> restates the default: a group is a list and a list is compact, so drop the prop`,
            });
        }

        // ── 5 · a mark sized by hand where the tier is handing the size out
        if (MARKS.has(name) && inLead() && /(?:^|\s):size="\d+"/u.test(attrs)) {
            findings.push({
                at: where,
                why: `<${name}> in a row's #lead is sized with a literal: take the tier's own — \`<template #lead="{ mark }">\` then \`:size="mark"\` — so a list's marks cannot drift apart again`,
            });
        }

        // Every non-native component's usages, for rule 6 below.
        if (/^[A-Z]/u.test(name)) {
            (usages.get(name) ?? usages.set(name, []).get(name)).push({ at: where, inGroup: inGroup(), sized: /(?:^|\s):?density="/u.test(attrs) });
        }

        if (selfClosing === `` && !VOID.has(name)) {
            stack.push({ name, transparent, lead: namedSlot && /(?:#lead|v-slot:lead)/u.test(attrs) });
        }
    }

    // Whether this file defines a row that leans on a group for its size: a `*Row.vue`'s template root is the
    // <Row>/<DisclosureRow> in question.
    const template = scan.indexOf(`<template>`);
    if (template !== -1) {
        const [first] = tags(scan, template + `<template>`.length);
        if (first !== undefined && (first.name === `Row` || first.name === `DisclosureRow`) && !/(?:^|\s):?density="/u.test(first.attrs)) {
            inheritingRows.add(
                path
                    .split(`/`)
                    .at(-1)
                    .replace(/\.vue$/u, ``),
            );
        }
    }
}

// ── 6 · a row that expects a group's tier, mounted where there is no group to read it from
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

finishFindings(
    findings,
    `with row tiers. A list's size is the list's answer, given once on its <RowGroup>; a header is the kit's, drawn by <SectionHeader>.`,
    `${tracked.length} templates: every row, outline and note takes its size from the group it is on, and every section header is the kit's`,
);
