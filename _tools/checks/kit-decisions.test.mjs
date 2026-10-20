// Pins what row-tiers, mark-alignment, kit-substitutes and recipe-tiers refuse as a view re-deciding one of the kit's
// looks: a header's count, caption, fill or spacing, a card laid in a card, a row's own height, an icon nudged onto its
// line by hand, a kit primitive drawn by hand, and a chip's or a pill's box restated; and what the kit's published
// checker tells an extension built outside this repository (check/extension.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionFindings } from "../../_shared/extension-ui/check/extension.mjs";
import { boxOverrides, glyphFindings, sectionFindings, substituteFindings } from "../../_shared/extension-ui/check/kit-decisions.mjs";
import { blank } from "./lib/templates.mjs";

const sfc = (template) => blank(`<script setup lang="ts">\nconst a = 1;\n</script>\n\n<template>\n${template}\n</template>\n`);
const sections = (template) => sectionFindings(`View.vue`, sfc(template)).map(({ why }) => why);
const glyphs = (template) => glyphFindings(`View.vue`, sfc(template)).map(({ why }) => why);
const substitutes = (template, path = `View.vue`) => substituteFindings(path, sfc(template)).map(({ rule }) => rule);

test(`a header decision taken at the call site is refused, whatever the binding`, () => {
    assert.equal(sections(`<div class="flex flex-col gap-6"><RowGroup label="A" :count="3" /></div>`).length, 1);
    assert.match(sections(`<RowGroup label="A" caption="words beside it" />`)[0], /takes no `caption`/u);
    assert.match(sections(`<RowGroup label="A" flat undivided />`)[0], /takes no `flat`/u);
    assert.match(sections(`<RowGroup label="A" :flat="true" />`)[0], /takes no `flat`/u);
    assert.match(sections(`<NavRail :groups="g" sticky-headings />`)[0], /takes no `sticky-headings`/u);
    assert.deepEqual(sections(`<RowGroup label="A" undivided equal-rows tone="danger" />`), []);
});

test(`the section label's look is refused on any element, a heading or not; the kit's header and a table's head are not`, () => {
    assert.deepEqual(substitutes(`<h3 class="mb-2 text-2xs font-semibold uppercase tracking-wide text-subtle">Apps</h3>`), [`label`]);
    assert.deepEqual(substitutes(`<div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">Recent</div>`), [`label`]);
    assert.deepEqual(substitutes(`<span :class="['uppercase', 'tracking-wider']">Hosted</span>`), [`label`]);
    assert.deepEqual(substitutes(`<SectionHeader label="Apps" :heading="3" />`), []);
    assert.deepEqual(substitutes(`<h3 class="text-sm font-semibold">Apps</h3>`), []);
    assert.deepEqual(substitutes(`<span class="uppercase">A</span>`), []);
    assert.deepEqual(substitutes(`<th class="uppercase tracking-wide">Name</th>`), []);
    const header = `<span class="uppercase tracking-wide">{{ label }}</span>`;
    assert.deepEqual(substitutes(header, `_editor/ui/src/components/rows/SectionHeader.vue`), []);
});

test(`a tab strip, a search field and an open row drawn by hand are refused outside the primitive that owns each`, () => {
    assert.deepEqual(substitutes(`<div role="tablist"><button role="tab">A</button></div>`), [`tabs`]);
    assert.deepEqual(substitutes(`<button :class="ui.tab(open === 'a')">A</button>`), [`tabs`]);
    assert.deepEqual(substitutes(`<div role="tablist" />`, `_editor/ui/src/components/forms/SegmentedControl.vue`), []);
    assert.deepEqual(substitutes(`<div class="ui-search-band relative"><input v-model="q" /></div>`), [`search`]);
    assert.deepEqual(substitutes(`<form class="flex"><Icon name="search" /><input v-model="q" type="text" /></form>`), [`search`]);
    assert.deepEqual(substitutes(`<input type="search" v-model="q" />`), [`search`]);
    assert.deepEqual(substitutes(`<span class="flex"><Icon name="search" /><span>a match</span></span>`), []);
    assert.deepEqual(substitutes(`<label class="flex"><Icon name="search" /></label><input v-model="name" />`), []);
    assert.deepEqual(substitutes(`<div :class="{ 'ui-row-open': open }"><button>row</button></div>`), [`open`]);
    assert.deepEqual(substitutes(`<div class="ui-row-open-later">x</div>`), []);
    assert.deepEqual(substitutes(`<div :class="ui-row-open" />`, `_editor/ui/src/components/rows/DisclosureRow.vue`), []);
});

test(`a group among another group's rows nests a card in a card; on the group's surface through a note it does not`, () => {
    assert.match(sections(`<RowGroup><Row title="a" /><RowGroup label="inner" /></RowGroup>`)[0], /nests one card in another/u);
    assert.deepEqual(sections(`<RowGroup><RowNote variant="block"><RowGroup label="inner" /></RowNote></RowGroup>`), []);
});

test(`sections side by side need a stack that spaces them`, () => {
    assert.match(sections(`<div><RowGroup label="a" /><RowGroup label="b" /></div>`)[0], /states no gap/u);
    assert.match(sections(`<RowGroup label="a" />\n<Section label="b" />`)[0], /at its root/u);
    assert.match(sections(`<div><RowGroup v-for="g in groups" :key="g" :label="g" /></div>`)[0], /states no gap/u);
    assert.deepEqual(sections(`<div class="flex flex-col gap-6"><RowGroup label="a" /><Section label="b" /></div>`), []);
    assert.deepEqual(sections(`<div><RowGroup v-if="a" label="a" /><RowGroup v-else label="b" /></div>`), []);
    assert.deepEqual(sections(`<div><RowGroup label="a" /><RowGroup class="mt-6" label="b" /></div>`), []);
    assert.deepEqual(
        sections(`<div class="flex flex-col gap-6"><template v-if="x"><RowGroup label="a" /><RowGroup label="b" /></template></div>`),
        [],
    );
});

test(`a row is as tall as its tier: a height of its own is refused`, () => {
    assert.match(sections(`<RowGroup><Row title="Theme" class="md:min-h-14" /></RowGroup>`)[0], /equal-rows/u);
    assert.match(sections(`<RowGroup><Row title="a" :class="[x ? 'h-12' : '']" /></RowGroup>`)[0], /height of its own/u);
    assert.deepEqual(sections(`<RowGroup equal-rows><Row title="Theme" class="rounded-md" /></RowGroup>`), []);
});

test(`an icon nudged onto its line by hand is refused; a positioned one is placement, not a nudge`, () => {
    assert.match(
        glyphs(`<p class="flex items-start gap-1.5 text-2xs"><Icon name="x" class="mt-0.5 shrink-0" /><span>t</span></p>`)[0],
        /nudges an <Icon>/u,
    );
    assert.equal(glyphs(`<span><Icon name="x" class="mr-1 inline-block align-[-0.1em]" />t</span>`).length, 1);
    assert.equal(glyphs(`<span><Icon name="x" :class="busy ? 'translate-y-px' : ''" />t</span>`).length, 1);
    assert.deepEqual(glyphs(`<div class="relative"><Icon name="search" class="absolute left-2 top-1/2 -translate-y-1/2" /></div>`), []);
    assert.deepEqual(glyphs(`<p class="flex items-start gap-1.5 text-2xs"><Icon name="x" class="shrink-0 text-xs" /><span>t</span></p>`), []);
});

test(`a glyph-led line states its own type, which the glyph's offset is read from`, () => {
    assert.match(
        glyphs(`<button class="flex items-start gap-2"><Icon name="u" /><span class="text-sm md:text-xs">Anyone</span></button>`)[0],
        /state the size on the line/u,
    );
    assert.match(glyphs(`<div class="flex items-start gap-2 text-xs"><Icon name="u" /><div class="text-sm">t</div></div>`)[0], /states `text-xs`/u);
    assert.deepEqual(
        glyphs(`<button class="flex items-start gap-2 text-sm md:text-xs"><Icon name="u" /><span class="md:text-xs text-sm">Anyone</span></button>`),
        [],
    );
    assert.deepEqual(glyphs(`<div class="flex items-start gap-2"><Icon name="u" /><span>inherits the line's</span></div>`), []);
    assert.deepEqual(glyphs(`<div class="flex items-center gap-2"><Icon name="u" /><span class="text-sm">not a leading line</span></div>`), []);
});

test(`a chip's or a pill's box restated at its call site is refused; layout, weight and ink are the call site's`, () => {
    assert.deepEqual(boxOverrides(`ui-chip shrink-0 gap-1 px-2 py-px`), { kind: `chip`, words: [`gap-1`, `px-2`, `py-px`] });
    assert.deepEqual(boxOverrides(`ui-status-pill shrink-0 text-2xs font-semibold`), { kind: `pill`, words: [`text-2xs`] });
    assert.deepEqual(boxOverrides(`ui.chip({ on: x }, \`h-6 px-1.5\`) max-md:h-8 rounded-md`), { kind: `chip`, words: [`max-md:h-8`, `rounded-md`] });
    assert.deepEqual(boxOverrides(`ui-chip ui-chip-sm ml-1 shrink-0 font-medium text-content hover:bg-overlay`), { kind: `chip`, words: [] });
    assert.deepEqual(boxOverrides(`ui-status-pill ui-status-pill-inline shrink-0`), { kind: `pill`, words: [] });
    assert.deepEqual(boxOverrides(`ui-chip-on px-2 text-xs`), { kind: undefined, words: [] });
    assert.deepEqual(boxOverrides(`flex gap-2 px-3`), { kind: undefined, words: [] });
});

// ── What an extension built outside this repository must change (the kit's published `intentic-kit-check`) ─────────
const SURFACE = {
    "2.20.0": {},
    "2.31.0": { uiKitExports: [`Row`, `SkeletonSnapshot`], moduleExports: [`sandboxPoll`] },
    "2.33.0": { uiKitExports: [`Await`, `Row`, `SkeletonSnapshot`], moduleExports: [`sandboxPoll`, `useLoaded`] },
    "2.34.0": { uiKitExports: [`Await`, `Row`, `Section`, `SkeletonSnapshot`], moduleExports: [`sandboxPoll`, `useLoaded`] },
};
const judge = (text, engines = `^2.34.0`, path = `src/View.vue`) =>
    extensionFindings({ files: [{ path, text }], manifest: { engines: { intentic: engines } }, surface: SURFACE });
const why = (findings) => findings.map((finding) => finding.why);
const view = (script, template = `<div />`) => `<script setup lang="ts">\n${script}\n</script>\n\n<template>\n${template}\n</template>\n`;

test(`a deprecated kit name imported says what replaced it; a type-only import links nothing`, () => {
    const found = judge(view(`import { Row, SkeletonSnapshot } from "@intentic/extension-ui";`));
    assert.equal(found.length, 1);
    assert.equal(found[0].at, `src/View.vue:2`);
    assert.match(found[0].why, /`SkeletonSnapshot` is deprecated since extension API 2\.33\.0.*use `Await`/u);
    assert.deepEqual(judge(view(`import type { SkeletonSnapshot } from "@intentic/extension-ui";`)), []);
});

test(`a retired prop and a recipe drawn by hand are refused, with the reason the kit records`, () => {
    assert.match(why(judge(view(``, `<RowGroup label="A" caption="words" />`)))[0], /takes no `caption`.*<RowNote>/u);
    assert.match(why(judge(view(`import { ui } from "@intentic/extension-ui";`, `<div :class="ui.sectionLabel('mb-1')">Services</div>`)))[0], /`ui\.sectionLabel` is retired since extension API 2\.34\.0/u);
    assert.match(why(judge(`const label = ui.sectionLabelSm("x");\n`, `^2.34.0`, `src/label.ts`))[0], /`ui\.sectionLabel` is retired/u);
});

test(`an engines floor below the version that brought an imported name asks for that version`, () => {
    const found = why(judge(view(`import { Await, Section } from "@intentic/extension-ui";\nimport { useLoaded } from "@intentic/extension-api";`), `^2.20.0`));
    assert.equal(found.length, 1);
    assert.match(found[0], /admits hosts from 2\.20\.0, which lack `Await`.*`Section` \(src\/View\.vue:2, from 2\.34\.0\).*raise it to "\^2\.34\.0"/u);
    assert.deepEqual(judge(view(`import { Await, Section } from "@intentic/extension-ui";`), `^2.34.0`), []);
    // A name already there when the grain was first recorded may be older than the record: no floor below it is judged.
    assert.deepEqual(judge(view(`import { Row } from "@intentic/extension-ui";\nimport { sandboxPoll } from "@intentic/extension-api";`), `^2.20.0`), []);
});

test(`a range the host cannot read, a name the kit lacks and an unreadable surface are each said`, () => {
    assert.match(why(judge(view(``), `>=2.0.0`))[0], /neither an exact version nor a caret range/u);
    assert.match(why(judge(view(`import { Nope } from "@intentic/extension-ui";`)))[0], /not a name the kit exports/u);
    const blind = extensionFindings({ files: [{ path: `src/a.ts`, text: `import { Row } from "@intentic/extension-ui";\n` }], manifest: { engines: { intentic: `^2.34.0` } }, surface: undefined });
    assert.match(why(blind)[0], /could not be read/u);
    assert.deepEqual(extensionFindings({ files: [{ path: `src/a.ts`, text: `export const a = 1;\n` }], manifest: { engines: { intentic: `^2.0.0` } }, surface: undefined }), []);
});

test(`a finding that is right to keep says so in place`, () => {
    assert.deepEqual(judge(view(`// allow(kit-check): kept for the desktop entry\nimport { SkeletonSnapshot } from "@intentic/extension-ui";`)), []);
});
