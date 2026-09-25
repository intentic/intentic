<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { useSandboxReadout } from "./sandboxFigures";

// The board's geek metrics at rest, inside their status-bar segment: three small gauges (CPU, memory, disk) and nothing
// else until something nears a limit, when that figure joins the line tinted. The rest (load, processes, pressure, the
// daemon, memory by kind) is the panel the segment opens, docked above the bar for as long as the reader keeps it.

const props = defineProps<{
    metrics: SandboxMetrics;
}>();

const readout = useSandboxReadout(() => props.metrics);
</script>

<template>
    <span class="flex min-w-0 items-center gap-4 overflow-hidden">
        <Icon name="server" class="shrink-0 text-2xs text-subtle" />
        <span v-for="gauge in readout.gauges" :key="gauge.key" data-figure class="inline-flex shrink-0 items-center gap-1.5">
            <span>{{ gauge.label }}</span>
            <span class="h-1 w-8 overflow-hidden rounded-full" :class="gauge.warn ? `bg-warning/20` : `bg-content/10`" aria-hidden="true">
                <span
                    class="block h-full rounded-full transition-[width] duration-500"
                    :class="gauge.warn ? `bg-warning` : `bg-content/35`"
                    :style="{ width: `${(gauge.fraction ?? 0) * 100}%` }"
                />
            </span>
            <span class="tabular-nums" :class="gauge.warn ? `text-warning` : ``">{{ gauge.value }}</span>
        </span>
        <!-- Only past a limit: a figure worth acting on shouldn't hide behind a click. -->
        <span v-for="alert in readout.alerts" :key="alert.key" data-figure class="inline-flex min-w-0 items-center gap-1.5 text-warning">
            <Icon name="exclamation-triangle" class="shrink-0 text-2xs" />
            <span class="shrink-0">{{ alert.label }}</span>
            <span class="truncate tabular-nums">{{ alert.value }}</span>
        </span>
    </span>
</template>
