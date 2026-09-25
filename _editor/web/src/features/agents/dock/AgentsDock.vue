<script setup lang="ts">
import type { MainlineStatus, SandboxMetrics } from "@intentic/sandbox-contract";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import MainlinePanel from "../mainline/MainlinePanel.vue";
import MainlineSummary from "../mainline/MainlineSummary.vue";
import { mainlineSummary } from "../mainline/mainlineView";
import SandboxMetricsDetails from "../metrics/SandboxMetricsDetails.vue";
import SandboxMetricsSummary from "../metrics/SandboxMetricsSummary.vue";
import type { DockSegment, DockState } from "./dockState";
import StatusDock from "./StatusDock.vue";

// The board's status dock: the main tree's own check and the sandbox's geek metrics, as two segments of one bar at the
// board's foot rather than a strip under its header and a popover each. Absent while neither has anything to say.

const t = useT();

const props = defineProps<{
    mainline: MainlineStatus | undefined;
    // Only the board reads them (useLiveMetrics), and only while the reader opted in.
    metrics?: SandboxMetrics | undefined;
    state: DockState;
    label: string;
}>();

// A conversation was opened from the main line, so a host that is a sheet can get out of the way.
const emit = defineEmits<{ opened: [conversationId: string] }>();

const summary = computed(() => mainlineSummary(props.mainline));

const segments = computed<DockSegment[]>(() => [
    ...(summary.value === undefined ? [] : [{ id: `mainline`, title: t(`agents.mainline.title`), icon: `list-check` as const }]),
    ...(props.metrics === undefined
        ? []
        : [{ id: `metrics`, title: t(`agents.liveMetrics.sandboxLabel`), icon: `server` as const, end: true }]),
]);
</script>

<template>
    <StatusDock v-if="segments.length > 0" v-model:open="state.open.value" v-model:height="state.height.value" :segments="segments" :label="label">
        <template #summary-mainline>
            <MainlineSummary v-if="summary !== undefined" :summary="summary" />
        </template>
        <template #panel-mainline>
            <MainlinePanel
                v-if="mainline !== undefined && summary !== undefined"
                :status="mainline"
                :summary="summary"
                @opened="(id: string) => emit(`opened`, id)"
            />
        </template>
        <template #summary-metrics>
            <SandboxMetricsSummary v-if="metrics !== undefined" :metrics="metrics" />
        </template>
        <template #panel-metrics>
            <SandboxMetricsDetails v-if="metrics !== undefined" :metrics="metrics" />
        </template>
    </StatusDock>
</template>
