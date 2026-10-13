<script setup lang="ts">
import { Icon, Notice, type NoticeModel, type Tone, toneInk, toneWash } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, useId } from "vue";
import { useRoute, useRouter } from "vue-router";
import DocumentsStep from "./DocumentsStep.vue";
import PlacesStep from "./PlacesStep.vue";
import ProtectionsStep from "./ProtectionsStep.vue";
import { stepCounts } from "./dataProtection";
import { useComplianceReport, usePreset } from "./useCompliance";

// The data protection page (Ochrona danych): what a sandbox needs before it handles anyone's personal data, as three
// steps in the order they are done. Protections first, since the documents are written from the settings as they are
// at the moment of download; then where data goes, which the officer lists as recipients; then the documents. Each
// step's tile says how that step stands before it is opened, so the tiles are the page's summary as well as its index.
//
// Until 2026-10-13 this was one page about seven screens long: documents, every data path in seven cards, twenty-five
// protections under six GDPR headings, and the public-office preset at the foot as a second list of the same switches.
// A newcomer met the documents first, before anything they describe was set, and read most switches twice.
//
// Maintainer and up see it; only the owner applies.

const t = useT();
const { report, error: reportError } = useComplianceReport();
const { items } = usePreset();

const STEPS = [`protections`, `places`, `documents`] as const;
type Step = (typeof STEPS)[number];
const route = useRoute();
const router = useRouter();
// In the query, as the Agent and Audit tabs' parts are, so a link lands on a step; the first writes no param, and a push
// lets Back return to the step before.
const step = computed<Step>({
    get: () => STEPS.find((entry) => entry === route.query[`step`]) ?? `protections`,
    set: (value) => void router.push({ query: { ...route.query, step: value === `protections` ? undefined : value } }),
});

const counts = computed(() => (report.value === undefined ? undefined : stepCounts(report.value.measures, report.value.flows, items.value ?? [])));

interface Tile {
    readonly key: Step;
    readonly title: string;
    line?: string;
    note?: { readonly text: string; readonly tone: Tone };
    /** Nothing left to do in it: its number becomes a tick. */
    done: boolean;
}

const tiles = computed<readonly Tile[]>(() => {
    const count = counts.value;
    // The recommendations are known only once the preset has answered; until then the tiles say nothing about them.
    const recommended = items.value === undefined ? undefined : count?.recommended;
    const protections: Tile = { key: `protections`, title: t(`sandbox.dataProtection.step.protections`), done: recommended === 0 };
    const places: Tile = { key: `places`, title: t(`sandbox.dataProtection.step.places`), done: false };
    const documents: Tile = {
        key: `documents`,
        title: t(`sandbox.dataProtection.step.documents`),
        line: t(`sandbox.dataProtection.tile.documents`),
        done: false,
    };
    if (count !== undefined) {
        protections.line = t(`sandbox.dataProtection.tile.protectionsOn`, { on: count.protectionsOn, total: count.protections });
        places.line = [
            t(`sandbox.dataProtection.tile.places`, { count: count.places }, count.places),
            t(`sandbox.dataProtection.tile.outsideEea`, { count: count.outsideEea }, count.outsideEea),
        ].join(` · `);
        if (count.questions > 0) {
            places.note = { text: t(`sandbox.dataProtection.tile.questions`, { count: count.questions }, count.questions), tone: `warning` };
        }
    }
    if (recommended !== undefined) {
        protections.note =
            recommended > 0
                ? { text: t(`sandbox.dataProtection.tile.recommended`, { count: recommended }, recommended), tone: `warning` }
                : { text: t(`sandbox.dataProtection.tile.allApplied`), tone: `success` };
        if (recommended > 0) {
            documents.note = { text: t(`sandbox.dataProtection.tile.bestAfter`), tone: `neutral` };
        }
    }
    return [protections, places, documents];
});

// The number's disc: a tick once the step is done, the accent while it is open, and otherwise only a disc, since a
// step not opened yet is no signal of anything.
const discOf = (tile: Tile): string => (tile.done ? toneWash(`success`) : step.value === tile.key ? toneWash(`primary`) : `bg-content/10 text-muted`);

// The tiles are a tab list: arrows move between them, as between any tabs.
const panelId = useId();
const tabId = (key: Step): string => `${panelId}-${key}`;
const focusTile = (event: KeyboardEvent, index: number): void => {
    const next = event.key === `ArrowRight` || event.key === `ArrowDown` ? index + 1 : event.key === `ArrowLeft` || event.key === `ArrowUp` ? index - 1 : undefined;
    if (next === undefined) {
        return;
    }
    event.preventDefault();
    const target = STEPS[(next + STEPS.length) % STEPS.length] ?? `protections`;
    step.value = target;
    document.getElementById(tabId(target))?.focus();
};

const pageNotice = computed<NoticeModel | undefined>(() =>
    reportError.value === undefined ? undefined : { tone: `danger`, title: t(`sandbox.dataProtection.couldntRead`), detail: reportError.value },
);
</script>

<template>
    <div class="@container flex flex-col gap-6">
        <p class="text-xs text-muted">{{ t(`sandbox.dataProtection.intro`) }}</p>
        <Notice v-if="pageNotice" :of="pageNotice" />

        <div role="tablist" :aria-label="t(`sandbox.dataProtection.steps`)" class="grid grid-cols-1 gap-2 @md:grid-cols-3">
            <button
                v-for="(tile, index) in tiles"
                :id="tabId(tile.key)"
                :key="tile.key"
                type="button"
                role="tab"
                :aria-selected="step === tile.key"
                :aria-controls="panelId"
                :tabindex="step === tile.key ? 0 : -1"
                class="ui-row-select flex min-w-0 items-start gap-3 rounded-xl border px-3 py-2.5 text-left"
                :class="step === tile.key ? `ui-row-select-on border-primary-500/60` : `border-line`"
                @click="step = tile.key"
                @keydown="(event: KeyboardEvent) => focusTile(event, index)"
            >
                <span class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold" :class="discOf(tile)">
                    <Icon v-if="tile.done" name="check" class="text-2xs" />
                    <template v-else>{{ index + 1 }}</template>
                </span>
                <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="text-sm font-medium text-content">{{ tile.title }}</span>
                    <span v-if="tile.line !== undefined" class="text-xs text-muted">{{ tile.line }}</span>
                    <span v-if="tile.note !== undefined" :class="toneInk(tile.note.tone, `text-xs`)">{{ tile.note.text }}</span>
                </span>
            </button>
        </div>

        <section :id="panelId" role="tabpanel" :aria-labelledby="tabId(step)">
            <ProtectionsStep v-if="step === `protections`" />
            <PlacesStep v-else-if="step === `places`" />
            <DocumentsStep v-else @back="step = `protections`" />
        </section>
    </div>
</template>
