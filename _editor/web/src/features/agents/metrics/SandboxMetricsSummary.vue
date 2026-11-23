<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract/schemas/metrics";
import { Meter } from "@intentic/ui";
import { GAUGE_GLYPH, useSandboxReadout } from "./sandboxFigures";

// The geek metrics at rest, in the board's header (BoardMetrics.vue): three small gauges (CPU, memory, disk), each its
// glyph and its meter, and no figure until one nears its limit, when that figure joins the line tinted. At rest the
// question is only "is anything running out?", which the meters answer; "5.7 / 17 GiB" beside each one made the line
// ~400px of numbers nobody read. The figures are the button's hover (BoardMetrics), and the rest (load, processes,
// pressure, the daemon, memory by kind) is the popover a press on them opens. A screen reader still hears each label and
// figure. The glyphs are always CPU, memory, disk in that order, and the hover names them. A figure raised past its limit
// speaks the same way: its own glyph (a clock for pressure), then each reading behind the glyph of what it measures, so
// pressure on I/O reads as the disk glyph and its percent rather than a sentence; its words are in the hover.

const props = defineProps<{
    metrics: SandboxMetrics;
}>();

const readout = useSandboxReadout(() => props.metrics);
</script>

<template>
    <span class="flex min-w-0 items-center gap-3 overflow-hidden">
        <span v-for="gauge in readout.gauges" :key="gauge.key" data-figure class="inline-flex shrink-0 items-center gap-1.5">
            <Icon :name="GAUGE_GLYPH[gauge.key]" aria-hidden="true" class="text-2xs" :class="gauge.warn ? `text-warning` : ``" />
            <span class="sr-only">{{ gauge.label }}</span>
            <Meter :value="gauge.fraction" :tone="gauge.warn ? `warning` : `muted`" class="w-6" />
            <span class="tabular-nums" :class="gauge.warn ? `text-warning` : `sr-only`">{{ gauge.value }}</span>
        </span>
        <!-- Only past a limit: a figure worth acting on shouldn't hide behind a click. -->
        <!-- Short of room an alert gives up its readings from the right and never spills into the next one. -->
        <span
            v-for="alert in readout.alerts"
            :key="alert.key"
            data-figure
            class="inline-flex min-w-0 items-center gap-1.5 overflow-hidden border-l border-content/10 pl-3 text-warning"
        >
            <template v-if="alert.glyph !== undefined">
                <Icon :name="alert.glyph" aria-hidden="true" class="shrink-0 text-2xs" />
                <span class="sr-only">{{ alert.label }}</span>
                <span
                    v-for="part in alert.parts ?? []"
                    :key="part.key"
                    class="inline-flex shrink-0 items-center gap-1"
                    :class="part.warn ? `` : `text-muted`"
                >
                    <Icon v-if="part.glyph !== undefined" :name="part.glyph" aria-hidden="true" class="text-2xs opacity-70" />
                    <span class="sr-only">{{ part.label }}</span>
                    <span class="tabular-nums">{{ part.value }}</span>
                </span>
            </template>
            <template v-else>
                <Icon name="exclamation-triangle" class="shrink-0 text-2xs" />
                <span class="min-w-0 truncate">{{ alert.label }}</span>
                <span class="min-w-0 shrink-[100] truncate tabular-nums">{{ alert.value }}</span>
            </template>
        </span>
    </span>
</template>
