<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { AnchoredOverlay } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import { showLiveMetrics } from "./liveMetrics";
import { useSandboxReadout } from "./sandboxFigures";
import SandboxMetricsDetails from "./SandboxMetricsDetails.vue";

// The board's geek metrics, docked at its foot like a status bar: three small gauges (CPU, memory, disk) and nothing
// else until something nears a limit, when that figure joins the line tinted. The rest (load, processes, pressure,
// the daemon, memory by kind) waits one click away in a panel, so the board's top stays the board's.

const t = useT();

const props = defineProps<{
    metrics: SandboxMetrics;
}>();

const readout = useSandboxReadout(() => props.metrics);

const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

const hide = (): void => {
    open.value = false;
    showLiveMetrics.value = false;
};
</script>

<template>
    <div role="group" :aria-label="t(`agents.liveMetrics.sandboxLabel`)" class="flex h-7 shrink-0 items-stretch border-t border-line px-1.5 text-2xs">
        <button
            ref="trigger"
            type="button"
            :aria-expanded="open"
            aria-haspopup="dialog"
            class="group flex min-w-0 items-center gap-4 overflow-hidden rounded-md px-1.5 text-subtle transition-colors hover:bg-content/5 hover:text-muted"
            :class="open ? `bg-content/5 text-muted` : ``"
            @click="open = !open"
        >
            <Icon name="server" class="shrink-0 text-2xs" />
            <span v-for="gauge in readout.gauges" :key="gauge.key" data-figure class="inline-flex shrink-0 items-center gap-1.5">
                <span>{{ gauge.label }}</span>
                <span class="h-1 w-8 overflow-hidden rounded-full" :class="gauge.warn ? `bg-warning/20` : `bg-content/10`" aria-hidden="true">
                    <span
                        class="block h-full rounded-full transition-[width] duration-500"
                        :class="gauge.warn ? `bg-warning` : `bg-content/35 group-hover:bg-primary-600`"
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
            <Icon
                name="chevron-up"
                class="shrink-0 text-2xs opacity-0 transition-opacity group-hover:opacity-100"
                :class="open ? `opacity-100` : ``"
            />
        </button>
        <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="top" cross="start">
            <SandboxMetricsDetails :metrics="metrics" @hide="hide" />
        </AnchoredOverlay>
    </div>
</template>
