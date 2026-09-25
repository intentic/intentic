<script setup lang="ts">
import type { MainlineStatus, SandboxMetrics } from "@intentic/sandbox-contract";
import { type IconName, ResizeSeam, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, useId } from "vue";
import MainlinePanel from "../mainline/MainlinePanel.vue";
import MainlineSummary from "../mainline/MainlineSummary.vue";
import { mainlineSummary } from "../mainline/mainlineView";
import SandboxMetricsDetails from "../metrics/SandboxMetricsDetails.vue";
import SandboxMetricsSummary from "../metrics/SandboxMetricsSummary.vue";
import { openPanel, PANEL_DEFAULT_HEIGHT, PANEL_MIN_HEIGHT, panelHeight, panelMaxHeight, type StatusSegment } from "./statusBarState";

// THE BOARD'S STATUS BAR: the main tree's own check and the sandbox's geek metrics, as two segments of one bar at the
// board's foot. Each says at rest what a reader most needs from it (what is running, what is red, how full the box
// is); pressing one opens its panel above the bar, in the layout rather than over it, so the board moves up
// instead of being covered, and nothing but the reader closes it again (its segment, its ×, or Escape inside it). The
// segments work as tabs: one panel at a time, with the whole width. The reader sets its height on the seam above it,
// and both are remembered (statusBarState.ts). Opaque, so a skin's backdrop does not show through. Absent while
// neither segment has anything to say.
//
// Drawn here rather than by a generic "status bar" with a slot per segment: this board is its only host, and its two
// segments are fixed, so the slot protocol, the ordering flag and the per-host memory it needed were all machinery for
// hosts that do not exist.

const t = useT();

const props = defineProps<{
    mainline: MainlineStatus | undefined;
    // Only the board reads them (useLiveMetrics), and only while the reader opted in.
    metrics?: SandboxMetrics | undefined;
}>();

const summary = computed(() => mainlineSummary(props.mainline));

interface Segment {
    readonly id: StatusSegment;
    // The panel's heading, and what its segment is named for a screen reader.
    readonly title: string;
    readonly icon: IconName;
}

// The main line leads; the metrics sit at the bar's far end.
const mainlineSegment = computed<Segment | undefined>(() =>
    summary.value === undefined ? undefined : { id: `mainline`, title: t(`agents.mainline.title`), icon: `list-check` },
);
const metricsSegment = computed<Segment | undefined>(() =>
    props.metrics === undefined ? undefined : { id: `metrics`, title: t(`agents.liveMetrics.sandboxLabel`), icon: `server` },
);
const segments = computed(() => [mainlineSegment.value, metricsSegment.value].filter((segment) => segment !== undefined));

const uid = useId();
const panelId = (id: StatusSegment): string => `${uid}-panel-${id}`;
const headingId = (id: StatusSegment): string => `${uid}-heading-${id}`;
const segmentId = (id: StatusSegment): string => `${uid}-segment-${id}`;

const isOpen = (id: StatusSegment): boolean => openPanel.value === id;
// A segment the board no longer draws (metrics turned off) stays open in memory, so it comes back as it was left.
const shown = computed(() => segments.value.find((segment) => isOpen(segment.id)));
// The height the reader chose, drawn no taller than this window allows; the seam drags only within it too.
const drawnHeight = computed(() => Math.min(panelHeight.value, panelMaxHeight.value));

const toggle = (id: StatusSegment): void => {
    openPanel.value = isOpen(id) ? undefined : id;
};

// Closing from inside the panel hands focus back to the segment that opened it, so a keyboard reader is not dropped.
const close = (id: StatusSegment): void => {
    openPanel.value = undefined;
    void nextTick(() => document.getElementById(segmentId(id))?.focus());
};
</script>

<template>
    <div
        v-if="segments.length > 0"
        role="region"
        :aria-label="t(`agents.statusBar.label`)"
        class="flex shrink-0 flex-col border-t border-line bg-canvas text-2xs"
    >
        <div v-if="shown !== undefined" data-status-panel class="relative flex min-h-0" :style="{ height: `${drawnHeight}px` }">
            <ResizeSeam
                v-model="panelHeight"
                axis="y"
                pane="after"
                place="edge"
                :min="PANEL_MIN_HEIGHT"
                :max="panelMaxHeight"
                :reset="PANEL_DEFAULT_HEIGHT"
                :title="t(`ui.resizeSeam.dragToResize`)"
            />
            <section
                :id="panelId(shown.id)"
                :key="shown.id"
                :data-panel="shown.id"
                :aria-labelledby="headingId(shown.id)"
                class="flex min-w-0 flex-1 flex-col"
                @keydown.esc.stop="close(shown.id)"
            >
                <header class="flex h-8 shrink-0 items-center gap-2 pr-1.5 pl-3">
                    <Icon :name="shown.icon" class="shrink-0 text-2xs text-subtle" />
                    <h3 :id="headingId(shown.id)" :class="ui.sectionLabelSm(`min-w-0 truncate`)">{{ shown.title }}</h3>
                    <button
                        type="button"
                        :class="ui.iconButton(`ml-auto hover:bg-content/10`)"
                        :aria-label="t(`agents.statusBar.close`, { title: shown.title })"
                        v-tooltip.top="t(`agents.statusBar.close`, { title: shown.title })"
                        @click="close(shown.id)"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                </header>
                <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                    <MainlinePanel v-if="shown.id === `mainline` && mainline !== undefined && summary !== undefined" :status="mainline" :summary="summary" />
                    <SandboxMetricsDetails v-else-if="shown.id === `metrics` && metrics !== undefined" :metrics="metrics" />
                </div>
            </section>
        </div>
        <div class="flex min-h-7 flex-wrap items-center gap-x-1 gap-y-0.5 px-1.5 py-0.5" :class="shown !== undefined ? `border-t border-line-subtle` : ``">
            <button
                v-for="segment in segments"
                :id="segmentId(segment.id)"
                :key="segment.id"
                type="button"
                :data-segment="segment.id"
                :aria-expanded="isOpen(segment.id)"
                :aria-controls="isOpen(segment.id) ? panelId(segment.id) : undefined"
                class="flex h-6 min-w-0 items-center gap-2 overflow-hidden rounded-md px-1.5 text-left transition-colors"
                :class="[
                    isOpen(segment.id) ? `bg-content/8 text-content` : `text-muted hover:bg-content/5 hover:text-content`,
                    segment.id === `metrics` ? `ml-auto` : ``,
                ]"
                @click="toggle(segment.id)"
            >
                <MainlineSummary v-if="segment.id === `mainline` && summary !== undefined" :summary="summary" />
                <SandboxMetricsSummary v-else-if="segment.id === `metrics` && metrics !== undefined" :metrics="metrics" />
                <Icon :name="isOpen(segment.id) ? `chevron-down` : `chevron-up`" class="shrink-0 text-2xs text-subtle" />
            </button>
        </div>
    </div>
</template>
