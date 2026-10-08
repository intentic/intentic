<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { ResizeSeam, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, useId } from "vue";
import SandboxMetricsDetails from "../metrics/SandboxMetricsDetails.vue";
import SandboxMetricsSummary from "../metrics/SandboxMetricsSummary.vue";
import { openPanel, PANEL_DEFAULT_HEIGHT, PANEL_MIN_HEIGHT, panelHeight, panelMaxHeight } from "./statusBarState";

// THE STATUS BAR: one line at the foot of the window saying what the sandbox is running and how full it is. Its start is
// the host's: the desktop shell puts its runtime chips there (shell/status-bar/), the terminal first. Its end is the
// geek metrics, opt-in (Settings ▸ Appearance), whose segment opens their panel above the bar.
//
// The panel opens in the layout rather than over it, so the page moves up instead of being covered, and nothing but the
// reader closes it again (its segment, its ×, or Escape inside it). It stays: its figures are few and live, watched
// while the agents work. The reader sets its height on the seam above it, and both are remembered (statusBarState.ts).
// Opaque, so a skin's backdrop does not show through.
//
// `persistent` is the desktop shell's: there the bar is always drawn, at one height, so no page jumps when a chip
// arrives. Without it (the phone's Agents board, which has no shell bar) the bar is the metrics alone and is absent
// while they are off.

const t = useT();

const props = defineProps<{
    // Read only while the reader opted in (useLiveMetrics).
    metrics?: SandboxMetrics | undefined;
    persistent?: boolean;
}>();

const uid = useId();
const panelId = `${uid}-panel-metrics`;
const headingId = `${uid}-heading-metrics`;
const segmentId = `${uid}-segment-metrics`;

const drawn = computed(() => props.persistent || props.metrics !== undefined);
// Left open while the metrics are off, it stays open in memory, so it comes back as it was left.
const open = computed(() => openPanel.value === `metrics` && props.metrics !== undefined);
// The height the reader chose, drawn no taller than this window allows; the seam drags only within it too.
const drawnHeight = computed(() => Math.min(panelHeight.value, panelMaxHeight.value));

const toggle = (): void => {
    openPanel.value = open.value ? undefined : `metrics`;
};

// Closing from inside the panel hands focus back to the segment that opened it, so a keyboard reader is not dropped.
const close = (): void => {
    openPanel.value = undefined;
    void nextTick(() => document.getElementById(segmentId)?.focus());
};
</script>

<template>
    <div
        v-if="drawn"
        role="region"
        :aria-label="t(`agents.statusBar.label`)"
        class="flex min-w-0 shrink-0 flex-col border-t border-line bg-canvas text-2xs"
    >
        <!-- `open` already means metrics; said again here only so the template narrows them for the panel. -->
        <div v-if="open && metrics !== undefined" data-status-panel class="relative flex min-h-0" :style="{ height: `${drawnHeight}px` }">
            <ResizeSeam
                v-model="panelHeight"
                axis="y"
                pane="after"
                place="edge"
                :min="PANEL_MIN_HEIGHT"
                :max="panelMaxHeight"
                :reset="PANEL_DEFAULT_HEIGHT"
                :title="t(`ui.resizeSeam.doubleClickResets`)"
            />
            <section :id="panelId" data-panel="metrics" :aria-labelledby="headingId" class="flex min-w-0 flex-1 flex-col" @keydown.esc.stop="close">
                <header class="flex h-8 shrink-0 items-center gap-2 pr-1.5 pl-3">
                    <Icon name="server" class="shrink-0 text-2xs text-subtle" />
                    <h3 :id="headingId" :class="ui.sectionLabelSm(`min-w-0 truncate`)">{{ t(`agents.liveMetrics.sandboxLabel`) }}</h3>
                    <button
                        type="button"
                        :class="ui.iconButton(`ml-auto hover:bg-content/10`)"
                        :aria-label="t(`agents.statusBar.close`, { title: t(`agents.liveMetrics.sandboxLabel`) })"
                        v-tooltip.top="t(`ui.action.close`)"
                        @click="close"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                </header>
                <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                    <SandboxMetricsDetails :metrics="metrics" />
                </div>
            </section>
        </div>
        <!-- One line, never two: a chip arriving or a long figure is cut, not wrapped, so the bar keeps its height. -->
        <div class="flex h-7 min-w-0 items-center gap-1 px-1.5" :class="open ? `border-t border-line-subtle` : ``">
            <slot name="start" />
            <!-- The metrics sit at the bar's far end. -->
            <button
                v-if="metrics !== undefined"
                :id="segmentId"
                type="button"
                data-segment="metrics"
                :aria-expanded="open"
                :aria-controls="open ? panelId : undefined"
                class="ml-auto flex h-6 min-w-0 shrink items-center gap-2 overflow-hidden rounded-md px-1.5 text-left transition-colors"
                :class="open ? `bg-content/8 text-content` : `text-muted hover:bg-content/5 hover:text-content`"
                @click="toggle"
            >
                <SandboxMetricsSummary :metrics="metrics" />
                <Icon :name="open ? `chevron-down` : `chevron-up`" class="shrink-0 text-2xs text-subtle" />
            </button>
        </div>
    </div>
</template>
