#!/usr/bin/env node
// Every list draws from one tier table via <RowGroup> (_editor/ui/src/components/rows/row.ts); a group is a list and a
// list is `compact`, with no call site stating otherwise.
// Refuses:
// a <RowGroup> child that sets its own padding — use <RowNote> instead
// a row inside a <RowGroup> that declares its own `density` (flush rows excepted)
// a <RowGroup> that restates the default `density="compact"`
// a literal `:size` on a mark inside `#lead`, where the tier already hands one out
// a row component (relying on its group for density) mounted outside any <RowGroup>
import { at, blank, classesOf, finishFindings, tags, templateSource, templatesUnder, VOID } from "./lib/templates.mjs";

// Any Tailwind padding utility, at any breakpoint; `p-0`/`py-0` are a deliberate reset, not geometry.
const PADDING = /(?:^|\s)(?:sm:|md:|lg:|xl:|2xl:|@\w+:|max-\w+:)?(?:p|px|py|pt|pb|pl|pr)-(?!0(?:\s|$))[\w.[\]/-]+/;
// Components that read the tier, plus the app's own `*Row` components wrapping one of them.
const ROW_LIKE = (name) => name === `Row` || name === `DisclosureRow` || name === `SkeletonRows` || name === `RowNote` || /.Row$/.test(name);
const MARKS = new Set([`BrandMark`, `Avatar`, `PersonaFace`]);

const tracked = templatesUnder(`_editor/web/src`, `_editor/ui/src`, `_shared/extension-ui/src`);
const findings = [];

// Components whose root is a bare <Row>/<DisclosureRow> with no density: they expect a group to size them.
const inheritingRows = new Set();
// Where each component is used, and whether that usage sat under a <RowGroup>.
const usages = new Map();

for (const path of tracked) {
    const scan = blank(templateSource(path));
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

        // ── 4 · a mark sized by hand where the tier is handing the size out
        if (MARKS.has(name) && inLead() && /(?:^|\s):size="\d+"/u.test(attrs)) {
            findings.push({
                at: where,
                why: `<${name}> in a row's #lead is sized with a literal: take the tier's own — \`<template #lead="{ mark }">\` then \`:size="mark"\` — so a list's marks cannot drift apart again`,
            });
        }

        // Every non-native component's usages, for rule 5 below.
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

finishFindings(
    findings,
    `with row tiers. A list's size is the list's answer, given once on its <RowGroup>.`,
    `${tracked.length} templates: every row, outline and note takes its size from the group it is on`,
);
