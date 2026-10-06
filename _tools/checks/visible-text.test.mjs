// Pins which literals inside a template's expressions the i18n-literals check reads as words on screen: what an
// interpolation or a bound label draws, and what a Notice's or a control's object hands to a reader, without the
// comparisons, enum arguments, classes and keys that only look like words.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installedModule, packages } from "./lib/repo.mjs";
import { visibleLiterals } from "./lib/visible-text.mjs";

const vueHost = packages.find(({ pkg }) => pkg.dependencies?.vue !== undefined || pkg.devDependencies?.vue !== undefined);
const sfc = vueHost === undefined ? undefined : installedModule(vueHost.dir, "vue/compiler-sfc");
const ts = vueHost === undefined ? undefined : installedModule(vueHost.dir, "typescript");
const skip = sfc === undefined || ts === undefined ? "vue/compiler-sfc and typescript need node_modules" : false;

const found = (template) =>
    visibleLiterals(`<template>${template}</template>`, "Probe.vue", { sfc, ts }).map((finding) =>
        finding.kind === "run" ? finding.parts.map((part) => part.text ?? "{…}").join("") : finding.text,
    );

test("a word an interpolation draws is reported, even a lone lowercase one", { skip }, () => {
    assert.deepEqual(found("<span>{{ n }} {{ n === 1 ? `slide` : `slides` }}</span>"), ["slide", "slides"]);
    assert.deepEqual(found("<span>{{ row.running ? 'running' : 'stopped' }}</span>"), ["running", "stopped"]);
    assert.deepEqual(found("<span>{{ name ?? `detached` }}</span>"), ["detached"]);
});

test("an English plural suffix glued on by a ternary is reported", { skip }, () => {
    assert.deepEqual(found("<span>{{ n }} {{ t(`agents.file`) }}{{ n === 1 ? '' : 's' }}</span>"), ["s"]);
});

test("a bound label's result is drawn, and so is what a template's placeholder holds", { skip }, () => {
    assert.deepEqual(found("<Badge :label=\"live ? 'live' : t(`views.notDeployed`)\" />"), ["live"]);
    assert.deepEqual(found('<b :aria-label="`${open ? `Collapse` : `Expand`} ${path}`" />'), ["Collapse", "Expand"]);
    // One sentence, reported once: the words inside its `${}` belong to it.
    assert.deepEqual(found('<RowGroup :count="`${used} of ${slots} ${slots === 1 ? `slot` : `slots`}`" />'), [" of  "]);
});

test("an object's visible keys are read on any bound attribute, its other keys are not", { skip }, () => {
    assert.deepEqual(found('<Notice :of="{ tone: `danger`, title: `Couldn\'t load your plan.`, detail: error }" />'), ["Couldn't load your plan."]);
    assert.deepEqual(found("<Seg :options=\"[{ label: 'Soft', value: 'soft' }, { label: t(`git.mixed`), value: 'mixed' }]\" />"), ["Soft"]);
    assert.deepEqual(found('<Notice :of="noticeOf(item.error ?? `The run did not say why.`)" />'), ["The run did not say why."]);
    assert.deepEqual(found('<Drawer :pt="{ header: { class: `!hidden` } }" />'), []);
});

test("values a lookup interpolates are drawn, and so is a join's separator", { skip }, () => {
    assert.deepEqual(found("<p>{{ t(`gate.explained`, { approvers: list.join(` or `), scope: `everyone` }) }}</p>"), [" or ", "everyone"]);
});

test("comparisons, enum arguments, keys, classes and brands are not words", { skip }, () => {
    assert.deepEqual(
        found(
            [
                '<b @click="go(action === `Roll back`)" />',
                "<span>{{ state === `running` ? t(`a.on`) : t(`a.off`) }}</span>",
                "<span>{{ bandLabel(`blocked`) }}</span>",
                "<span>{{ kinds.includes(`stopped`) ? t(`a.x`) : `` }}</span>",
                "<span>{{ LABELS[`pending`] }}</span>",
                '<b :class="busy ? `opacity-50 cursor-wait` : ``" :variant="ok ? `success` : `neutral`" :to="{ name: `home` }" />',
                '<Seg :options="[{ label: `Linux / macOS`, value: `unix` }, { label: `Windows`, value: `windows` }]" />',
                "<span>{{ t(`docxCompare.${kind}`) }}</span>",
            ].join(""),
        ),
        [],
    );
});
