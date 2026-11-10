<!-- THE GEEK METRICS ON THE AGENTS BOARD (AgentsView.vue), in its header beside New agent and nowhere else: three small
     meters with their figures, no frame and no line of their own, so they take none of the board's height. A figure near
     its limit turns amber and says so in place. Pressed, the full readout (load, processes, pressure, memory by kind,
     each agent's share) hangs off them as a popover, over the board rather than pushing it up, and goes when the reader
     clicks away or presses Escape. Drawn only while the reader opted in (Settings ▸ Appearance ▸ Geek metrics). -->
<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract/schemas/metrics";
import { ResponsiveOverlay, SectionHeader } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref, useId, watch } from "vue";
import { metricsAsked } from "./boardMetricsAsk";
import SandboxMetricsDetails from "./SandboxMetricsDetails.vue";
import SandboxMetricsSummary from "./SandboxMetricsSummary.vue";
import { useSandboxReadout } from "./sandboxFigures";

const props = defineProps<{
    metrics: SandboxMetrics;
    /** A narrow board keeps the meters and drops the words beside them; the hover and the readout still say them. */
    compact?: boolean;
}>();

const t = useT();
// The hover names what the bare meters are, with their figures, since a compact header draws the meters alone.
const readout = useSandboxReadout(() => props.metrics);
const tip = computed(() => ({
    title: t(`agents.liveMetrics.sandboxLabel`),
    rows: readout.value.gauges.map((gauge) => ({ label: gauge.label, value: gauge.value })),
}));
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
        <SandboxMetricsSummary :metrics="metrics" :compact="compact" class="text-2xs" />
    </button>
    <ResponsiveOverlay
        v-model="open"
        :anchor="anchor"
        side="bottom"
        cross="end"
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
