<!-- THE GEEK METRICS ON THE AGENTS BOARD (AgentsView.vue), in one of two places, never both:

     - `corner`: a card at the foot of the board's first column, its bottom-left, as Usage left stands at its bottom-right.
       Open, each gauge a row with its figure and what else is wrong with it; `fold`, one row (its heading and the line
       SandboxMetricsSummary draws), when the cards in that column need the height (metricsCorner.ts). The whole card is
       one press, since none of it is a control of its own.
     - `header`: the same one line in the board's header, where a stacked board (no columns, so no corner) keeps it.

     Pressed, the full readout (load, processes, pressure, memory by kind, each agent's share) hangs off it as a popover,
     over the board rather than pushing it, and goes when the reader clicks away or presses Escape. Drawn only while the
     reader opted in (Settings ▸ Appearance ▸ Geek metrics). -->
<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract/schemas/metrics";
import { Meter, ResponsiveOverlay, SectionHeader } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref, useId, watch } from "vue";
import { metricsAsked } from "./boardMetricsAsk";
import SandboxMetricsDetails from "./SandboxMetricsDetails.vue";
import SandboxMetricsSummary from "./SandboxMetricsSummary.vue";
import { type Gauge, useSandboxReadout } from "./sandboxFigures";

const {
    metrics,
    place = `header`,
    fold = false,
} = defineProps<{
    metrics: SandboxMetrics;
    place?: `header` | `corner`;
    // The corner as one row (metricsCorner.ts); the header is always one.
    fold?: boolean;
}>();

const t = useT();
// The hover names what the bare meters are, with their figures, since the line draws only glyphs and meters.
const readout = useSandboxReadout(() => metrics);
const tip = computed(() => ({
    title: t(`agents.liveMetrics.sandboxLabel`),
    rows: [...readout.value.gauges, ...readout.value.alerts].map((figure) => ({ label: figure.label, value: figure.value })),
}));
// What is wrong with each gauge, said under it in the open corner; the daemon has no gauge, so it is a row of its own.
const notesOf = (key: Gauge[`key`]): readonly string[] | undefined => readout.value.strains.find((strain) => strain.key === key)?.notes;
const daemon = computed(() => readout.value.strains.find((strain) => strain.key === `daemon`));
// The corner's visible rows are hidden from a screen reader, which hears them all in the press's name instead.
const spoken = computed(() =>
    [
        t(`agents.liveMetrics.sandboxLabel`),
        ...readout.value.gauges.map((gauge) => [gauge.label, gauge.detail, ...(notesOf(gauge.key) ?? [])].join(` `)),
        ...(daemon.value === undefined ? [] : [`${daemon.value.label} ${daemon.value.value}`]),
    ].join(`, `),
);
const anchor = ref<HTMLElement>();
const open = ref(false);
const headingId = `${useId()}-metrics`;

// Asked for from the rail (a figure near its limit): open once the board is here, and the ask is spent.
const takeAsk = (): void => {
    if (metricsAsked.value) {
        metricsAsked.value = false;
        open.value = true;
    }
};
onMounted(takeAsk);
watch(metricsAsked, takeAsk);
</script>

<template>
    <button
        v-if="place === `header`"
        ref="anchor"
        type="button"
        data-board-metrics
        :aria-expanded="open"
        aria-haspopup="dialog"
        class="flex h-7 min-w-0 shrink items-center overflow-hidden rounded-md px-1.5 transition-colors"
        :class="open ? `bg-content/8 text-content` : `text-muted hover:bg-content/5 hover:text-content`"
        v-tooltip.bottom="open ? undefined : tip"
        @click="open = !open"
    >
        <SandboxMetricsSummary :metrics="metrics" class="text-2xs" />
    </button>
    <!-- On a card's ground, as Usage left is in the opposite corner, under a heading as short as Usage left's, so the folded
         row keeps its width for the figures. Folded, it floats over the cards passing under it, so it is lifted off them as
         a card's hover bar is. The press lies over the card (a heading is no button's content), as Usage left's folded row's does. -->
    <div
        v-else
        ref="anchor"
        data-board-metrics-corner
        class="relative rounded-2xl border border-line bg-card"
        :class="[open ? `text-content` : `text-muted`, fold ? `shadow-md` : ``]"
    >
        <div class="flex min-w-0 items-center gap-2 px-3 py-2" aria-hidden="true">
            <SectionHeader :label="t(`agents.liveMetrics.cornerLabel`)" density="dense" class="shrink-0" />
            <SandboxMetricsSummary v-if="fold" :metrics="metrics" class="ml-auto text-2xs" />
        </div>
        <div v-if="!fold" class="flex flex-col gap-2.5 px-3 pb-3" aria-hidden="true">
            <div v-for="gauge in readout.gauges" :key="gauge.key" data-figure class="flex flex-col gap-1">
                <div class="flex items-baseline gap-2 text-2xs">
                    <span class="shrink-0 text-muted">{{ gauge.label }}</span>
                    <span class="ml-auto truncate tabular-nums" :class="notesOf(gauge.key) === undefined ? `text-content` : `text-warning`">{{
                        gauge.detail
                    }}</span>
                </div>
                <Meter :value="gauge.fraction" :tone="notesOf(gauge.key) === undefined ? `muted` : `warning`" />
                <span v-if="(notesOf(gauge.key)?.length ?? 0) > 0" class="truncate text-2xs text-warning">{{ notesOf(gauge.key)?.join(` · `) }}</span>
            </div>
            <div v-if="daemon !== undefined" data-figure class="flex items-baseline gap-2 text-2xs text-warning">
                <span class="shrink-0">{{ daemon.label }}</span>
                <span class="ml-auto truncate tabular-nums">{{ daemon.value }}</span>
            </div>
        </div>
        <button
            type="button"
            data-board-metrics
            class="absolute inset-0 rounded-[inherit] transition-colors hover:bg-content/4 motion-reduce:transition-none"
            :class="open ? `bg-content/4` : ``"
            :aria-label="spoken"
            :aria-expanded="open"
            aria-haspopup="dialog"
            v-tooltip.top="open ? undefined : fold ? tip : t(`agents.liveMetrics.allFigures`)"
            @click="open = !open"
        />
    </div>
    <ResponsiveOverlay
        v-model="open"
        :anchor="anchor"
        :side="place === `header` ? `bottom` : `top`"
        :cross="place === `header` ? `end` : `start`"
        :header="t(`agents.liveMetrics.sandboxLabel`)"
        panel-class="w-[40rem] max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto p-3"
    >
        <section data-panel="metrics" :aria-labelledby="headingId">
            <SandboxMetricsDetails :metrics="metrics">
                <template #header>
                    <header class="flex h-6 shrink-0 items-center gap-2">
                        <Icon name="server" class="shrink-0 text-2xs text-subtle" />
                        <SectionHeader :label="t(`agents.liveMetrics.sandboxLabel`)" density="dense" :heading="3" :id="headingId" />
                    </header>
                </template>
            </SandboxMetricsDetails>
        </section>
    </ResponsiveOverlay>
</template>
