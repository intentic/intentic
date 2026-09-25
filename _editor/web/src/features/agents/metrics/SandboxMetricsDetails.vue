<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { useT } from "@intentic/ui/i18n";
import { useSandboxReadout } from "./sandboxFigures";

// The panel the board's metrics bar opens: every figure the bar leaves out, grouped by what it answers. The gauges
// again at full width, then the machine's other readings, then which kinds of process hold the memory. Every figure
// explains itself on hover, since "load" or "pressure" is a number only a reader who already knows it can read bare.

const t = useT();

const props = defineProps<{
    metrics: SandboxMetrics;
}>();

const emit = defineEmits<{
    // Turns geek metrics off, from where they are seen rather than from Settings.
    hide: [];
}>();

const readout = useSandboxReadout(() => props.metrics);
</script>

<template>
    <div class="flex w-80 flex-col gap-3 p-3" :aria-label="t(`agents.liveMetrics.sandboxLabel`)">
        <div class="flex items-center gap-2">
            <Icon name="server" class="shrink-0 text-2xs text-subtle" />
            <h3 class="min-w-0 flex-1 truncate text-xs font-medium text-content">{{ t(`agents.liveMetrics.sandboxLabel`) }}</h3>
            <button
                type="button"
                v-tooltip.top="t(`agents.liveMetrics.hideHint`)"
                class="shrink-0 rounded px-1 py-px text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="emit(`hide`)"
            >
                {{ t(`agents.liveMetrics.hide`) }}
            </button>
        </div>

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
            class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-line-subtle pt-3 text-2xs"
        >
            <template v-for="figure in readout.figures" :key="figure.key">
                <dt v-tooltip.left="figure.hint" class="cursor-help text-muted">{{ figure.label }}</dt>
                <dd class="truncate text-right tabular-nums" :class="figure.warn ? `text-warning` : `text-content`">{{ figure.value }}</dd>
            </template>
        </dl>

        <div v-if="readout.roles.length > 0" role="group" data-section="roles" class="flex flex-col gap-1.5 border-t border-line-subtle pt-3">
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
                class="grid grid-cols-[7.5rem_minmax(0,1fr)_auto] items-center gap-2 text-2xs"
            >
                <span class="truncate text-muted">{{ role.label }}</span>
                <div class="h-1 overflow-hidden rounded-full bg-content/5" aria-hidden="true">
                    <div class="h-full rounded-full bg-primary-600/60 transition-[width] duration-500" :style="{ width: `${role.share * 100}%` }" />
                </div>
                <span class="text-right tabular-nums text-content">{{ role.value }}</span>
            </div>
        </div>

        <p class="text-2xs leading-relaxed text-subtle">{{ t(`agents.liveMetrics.measuredNote`) }}</p>
    </div>
</template>
