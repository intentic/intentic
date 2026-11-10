<!-- THE GEEK METRICS, AWAY FROM THE BOARD: their gauges live at the foot of the Agents board (MetricsStrip.vue), and
     anywhere else the rail says only that one of them is near its limit, with an amber dot on a tile that is there only
     while that lasts. A press opens the board with the metrics panel open, where the figure is. Nothing with the metrics
     off, since then nothing is measured (liveMetrics.ts). -->
<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract/schemas/metrics";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useT } from "@intentic/ui/i18n";
import { openPanel } from "../../../features/agents/metrics/metricsStripState";
import { useSandboxReadout } from "../../../features/agents/metrics/sandboxFigures";
import { here, page, routeShows } from "../../../lib/routes/links";
import ToolTile from "./ToolTile.vue";

const t = useT();
const route = useRoute();
const router = useRouter();
// Drawn only while the metrics are on (RailTools.vue), so there is always a reading.
const props = defineProps<{ metrics: SandboxMetrics }>();
const readout = useSandboxReadout(() => props.metrics);
const near = computed(() => [
    ...readout.value.gauges.filter((gauge) => gauge.warn).map((gauge) => ({ label: gauge.label, value: gauge.value })),
    ...readout.value.alerts.map((alert) => ({ label: alert.label, value: alert.value })),
]);
const onBoard = computed(() => routeShows(route, here(page.agents())));
const shown = computed(() => near.value.length > 0 && !onBoard.value);
const title = computed(() => t(`shell.railTools.nearLimit`));

const press = (): void => {
    openPanel.value = `metrics`;
    void router.push(here(page.agents()));
};
</script>

<template>
    <ToolTile
        v-if="shown"
        section="metrics"
        icon="server"
        :aria="`${title}: ${near.map((row) => `${row.label} ${row.value}`).join(`, `)}`"
        :tip="{ title, tone: `warning`, rows: near }"
        dot="warning"
        rail-key="tool:metrics"
        rail-into="sections"
        @press="press"
    />
</template>
