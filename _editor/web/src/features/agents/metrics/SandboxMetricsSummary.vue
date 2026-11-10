<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract/schemas/metrics";
import { Meter } from "@intentic/ui";
import { useSandboxReadout } from "./sandboxFigures";

// The geek metrics at rest, in the board's header (BoardMetrics.vue): three small gauges (CPU, memory, disk) and nothing
// else until something nears a limit, when that figure joins the line tinted. The rest (load, processes, pressure, the
// daemon, memory by kind) is the popover a press on them opens. `compact` (a narrow board) keeps the meters and drops
// the words, except a figure near its limit, which keeps its number.

const props = defineProps<{
    metrics: SandboxMetrics;
    compact?: boolean;
}>();

const readout = useSandboxReadout(() => props.metrics);
</script>

<template>
    <span class="flex min-w-0 items-center gap-3 overflow-hidden">
        <span v-for="gauge in readout.gauges" :key="gauge.key" data-figure class="inline-flex shrink-0 items-center gap-1.5">
            <span v-if="!compact">{{ gauge.label }}</span>
            <Meter :value="gauge.fraction" :tone="gauge.warn ? `warning` : `muted`" class="w-6" />
            <span v-if="!compact || gauge.warn" class="tabular-nums" :class="gauge.warn ? `text-warning` : ``">{{ gauge.value }}</span>
        </span>
        <!-- Only past a limit: a figure worth acting on shouldn't hide behind a click. -->
        <span v-for="alert in readout.alerts" :key="alert.key" data-figure class="inline-flex min-w-0 items-center gap-1.5 text-warning">
            <Icon name="exclamation-triangle" class="shrink-0 text-2xs" />
            <span class="shrink-0">{{ alert.label }}</span>
            <span class="truncate tabular-nums">{{ alert.value }}</span>
        </span>
    </span>
</template>
