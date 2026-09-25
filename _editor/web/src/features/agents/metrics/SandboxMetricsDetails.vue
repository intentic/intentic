<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { useT } from "@intentic/ui/i18n";
import { useSandboxReadout } from "./sandboxFigures";

// The panel the board's metrics segment opens, docked above its status bar: every figure the bar leaves out, grouped by
// what it answers. The gauges again with their capacity, then the machine's other readings, then which kinds of process
// hold the memory, side by side while the dock is wide. Every figure explains itself on hover, since "load" or
// "pressure" is a number only a reader who already knows it can read bare. Its heading, its note and the way to turn
// geek metrics off are the dock's header (BoardDock.vue).

const t = useT();

const props = defineProps<{
    metrics: SandboxMetrics;
}>();

const readout = useSandboxReadout(() => props.metrics);
</script>

<template>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] items-start gap-x-6 gap-y-3 pt-1">
        <!-- The figures that run out, each a meter: its fill says how close, its track the rest of the room. -->
        <div role="group" data-section="gauges" class="flex flex-col gap-2.5">
            <div v-for="gauge in readout.gauges" :key="gauge.key" v-tooltip.left="gauge.hint" data-figure class="flex cursor-help flex-col gap-1">
                <div class="flex items-baseline gap-2 text-2xs">
                    <span class="shrink-0 text-muted">{{ gauge.label }}</span>
                    <span class="ml-auto truncate tabular-nums" :class="gauge.warn ? `text-warning` : `text-content`">{{ gauge.detail }}</span>
                </div>
                <div
                    class="h-1 overflow-hidden rounded-full"
                    :class="gauge.warn ? `bg-warning/15` : `bg-content/8`"
                    role="meter"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    :aria-valuenow="gauge.fraction === undefined ? undefined : Math.round(gauge.fraction * 100)"
                    :aria-valuetext="gauge.detail"
                    :aria-label="gauge.label"
                >
                    <div
                        class="h-full rounded-full transition-[width] duration-500"
                        :class="gauge.warn ? `bg-warning` : `bg-primary-600`"
                        :style="{ width: `${(gauge.fraction ?? 0) * 100}%` }"
                    />
                </div>
            </div>
        </div>

        <dl
            role="group"
            data-section="figures"
            class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-2xs"
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

        <div v-if="readout.roles.length > 0" role="group" data-section="roles" class="flex flex-col gap-1.5">
            <h4
                v-tooltip.left="t(`agents.liveMetrics.rolesHint`)"
                class="cursor-help self-start text-2xs font-medium uppercase tracking-wide text-subtle"
            >
                {{ t(`agents.liveMetrics.rolesLabel`) }}
            </h4>
            <div
                v-for="role in readout.roles"
                :key="role.key"
                data-figure
                class="grid grid-cols-[minmax(0,7.5rem)_minmax(1.5rem,1fr)_auto] items-center gap-2 text-2xs"
            >
                <span class="truncate text-muted">{{ role.label }}</span>
                <div class="h-1 overflow-hidden rounded-full bg-content/5" aria-hidden="true">
                    <div class="h-full rounded-full bg-primary-600/60 transition-[width] duration-500" :style="{ width: `${role.share * 100}%` }" />
                </div>
                <span class="text-right whitespace-nowrap tabular-nums text-content">{{ role.value }}</span>
            </div>
        </div>
    </div>
</template>
