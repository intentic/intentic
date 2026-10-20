// Pins what row-tiers and mark-alignment refuse as a view re-deciding one of the kit's looks: a header's count,
// caption, fill or spacing, a card laid in a card, a row's own height, and an icon nudged onto its line by hand.
import assert from "node:assert/strict";
import { test } from "node:test";
import { glyphFindings, sectionFindings } from "./lib/kit-decisions.mjs";
import { blank } from "./lib/templates.mjs";

const sfc = (template) => blank(`<script setup lang="ts">\nconst a = 1;\n</script>\n\n<template>\n${template}\n</template>\n`);
const sections = (template) => sectionFindings(`View.vue`, sfc(template)).map(({ why }) => why);
const glyphs = (template) => glyphFindings(`View.vue`, sfc(template)).map(({ why }) => why);

test(`a header decision taken at the call site is refused, whatever the binding`, () => {
    assert.equal(sections(`<div class="flex flex-col gap-6"><RowGroup label="A" :count="3" /></div>`).length, 1);
    assert.match(sections(`<RowGroup label="A" caption="words beside it" />`)[0], /takes no `caption`/u);
    assert.match(sections(`<RowGroup label="A" flat undivided />`)[0], /takes no `flat`/u);
    assert.match(sections(`<RowGroup label="A" :flat="true" />`)[0], /takes no `flat`/u);
    assert.match(sections(`<NavRail :groups="g" sticky-headings />`)[0], /takes no `sticky-headings`/u);
    assert.deepEqual(sections(`<RowGroup label="A" undivided equal-rows tone="danger" />`), []);
});

test(`a section header drawn by hand on a heading element is refused; the kit's header is not`, () => {
    assert.match(sections(`<h3 class="mb-2 text-2xs font-semibold uppercase tracking-wide text-subtle">Apps</h3>`)[0], /<Section :label>/u);
    assert.deepEqual(sections(`<SectionHeader label="Apps" :heading="3" />`), []);
    assert.deepEqual(sections(`<h3 class="text-sm font-semibold">Apps</h3>`), []);
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
