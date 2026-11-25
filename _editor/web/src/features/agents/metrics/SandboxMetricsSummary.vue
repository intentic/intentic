<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract/schemas/metrics";
import { Meter } from "@intentic/ui";
import { toneWash } from "@intentic/ui/tone";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { GAUGE_GLYPH, useSandboxReadout } from "./sandboxFigures";

// The geek metrics in one line, at the right of the board's header (BoardMetrics.vue).
// At rest, three small gauges (CPU, memory, disk), each its glyph and its meter, and no figure: the question is only "is
// anything running out?", which the meters answer, and "5.7 / 17 GiB" beside each one made the line ~400px of numbers
// nobody read. The figures are the hover, the rest the popover a press opens. A screen reader still hears each one.
//
// ONCE ANYTHING NEARS A LIMIT the meters give way to one verdict: the resource worst off, in words, with what else is wrong
// with it ("Memory 13 / 17 GiB · swap full · 31% stalled"), and "+N" for the other resources short. One line whatever
// goes wrong: until 2026-11-24 every warning was appended after the meters as a group of its own, and a line short of
// room cut them off from the right, so the figures worth acting on were the first to go.

const props = defineProps<{
    metrics: SandboxMetrics;
}>();

const t = useT();
const readout = useSandboxReadout(() => props.metrics);
const worst = computed(() => readout.value.strains[0]);
const others = computed(() => readout.value.strains.length - 1);
</script>

<template>
    <span v-if="worst === undefined" class="flex min-w-0 items-center gap-3 overflow-hidden">
        <span v-for="gauge in readout.gauges" :key="gauge.key" data-figure class="inline-flex shrink-0 items-center gap-1.5">
            <Icon :name="GAUGE_GLYPH[gauge.key]" aria-hidden="true" class="text-2xs" />
            <span class="sr-only">{{ gauge.label }}</span>
            <Meter :value="gauge.fraction" tone="muted" class="w-6" />
            <span class="sr-only tabular-nums">{{ gauge.value }}</span>
        </span>
    </span>
    <!-- The figure keeps its place and the notes give way, so a narrow line still says what and how much. -->
    <span v-else data-verdict :class="toneWash(`warning`, `flex h-6 min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-2 whitespace-nowrap`)">
        <span class="shrink-0 font-medium">{{ worst.label }}</span>
        <span v-if="worst.value !== ``" class="shrink-0 tabular-nums">{{ worst.value }}</span>
        <span v-if="worst.notes.length > 0" class="min-w-0 truncate">· {{ worst.notes.join(` · `) }}</span>
        <span v-if="others > 0" class="shrink-0 tabular-nums opacity-70">
            <span aria-hidden="true">+{{ others }}</span>
            <span class="sr-only">{{ t(`agents.liveMetrics.moreStrained`, { count: others }, others) }}</span>
        </span>
    </span>
</template>
