<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { Meter, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useSandboxReadout } from "./sandboxFigures";

// The panel the board's metrics segment opens, docked above its status bar: every figure the bar leaves out, grouped by
// what it answers. The gauges again with their capacity, then the machine's other readings, then which kinds of process
// hold the memory, side by side while the dock is wide. The kinds take whatever width is left and flow into as many
// columns as fit, so the panel stays about as tall as its three gauges rather than growing a scrollbar. Every figure
// explains itself on hover, since "load" or "pressure" is a number only a reader who already knows it can read bare. Its
// heading is the status bar panel's header (BoardStatusBar.vue).

const t = useT();

const props = defineProps<{
    metrics: SandboxMetrics;
}>();

const readout = useSandboxReadout(() => props.metrics);
</script>

<template>
    <div class="flex flex-wrap items-start gap-x-8 gap-y-3 pt-1">
        <!-- The figures that run out, each a meter: its fill says how close, its track the rest of the room. -->
        <div role="group" data-section="gauges" class="flex w-44 shrink-0 flex-col gap-2.5">
            <div v-for="gauge in readout.gauges" :key="gauge.key" v-tooltip.left="gauge.hint" data-figure class="flex cursor-help flex-col gap-1">
                <div class="flex items-baseline gap-2 text-2xs">
                    <span class="shrink-0 text-muted">{{ gauge.label }}</span>
                    <span class="ml-auto truncate tabular-nums" :class="gauge.warn ? `text-warning` : `text-content`">{{ gauge.detail }}</span>
                </div>
                <Meter :value="gauge.fraction" :tone="gauge.warn ? `warning` : `accent`" :label="gauge.label" :valuetext="gauge.detail" />
            </div>
        </div>

        <dl
            role="group"
            data-section="figures"
            class="grid w-72 shrink-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-2xs"
        >
            <template v-for="figure in readout.figures" :key="figure.key">
                <dt v-tooltip.left="figure.hint" class="cursor-help text-muted">{{ figure.label }}</dt>
                <dd
                    class="truncate text-right tabular-nums"
                    :class="figure.warn ? `text-warning` : `text-content`"
                    v-tooltip.bottom.overflow="figure.value"
                >
                    {{ figure.value }}
                </dd>
            </template>
        </dl>

        <div v-if="readout.roles.length > 0" role="group" data-section="roles" class="flex min-w-56 flex-1 flex-col gap-1.5">
            <h4 v-tooltip.left="t(`agents.liveMetrics.rolesHint`)" :class="ui.sectionLabelSm(`cursor-help self-start`)">
                {{ t(`agents.liveMetrics.rolesLabel`) }}
            </h4>
            <div class="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-x-6 gap-y-1.5">
                <div
                    v-for="role in readout.roles"
                    :key="role.key"
                    data-figure
                    class="grid grid-cols-[minmax(0,7.5rem)_minmax(1.5rem,1fr)_auto] items-center gap-2 text-2xs"
                >
                    <span class="truncate text-muted">{{ role.label }}</span>
                    <Meter :value="role.share" />
                    <span class="text-right whitespace-nowrap tabular-nums text-content">{{ role.value }}</span>
                </div>
            </div>
        </div>
    </div>
</template>
