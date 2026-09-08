<script setup lang="ts">
import type { PipelineJob } from "@intentic/sandbox-contract";
import { DagGraph, Icon, ui, type DagNode } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { pipelineDag, type PipelineJobCluster, type PipelineStage, stageOfNode } from "./pipelineDag";
import { formatDuration, STATUS_TONE, type StatusTone } from "./statusVisual";

// Job graph: one card per group of identically-wired jobs, so parallel jobs sharing every edge collapse into one set of
// arrows. Below `readableZoom` the canvas stops shrinking rather than crop or blur past legibility. Hover traces one
// job's card through the run; a click pins it.

const {
    stages,
    recurring,
    fill = false,
} = defineProps<{
    stages: readonly PipelineStage[];
    // Job name to consecutive failing runs; the single most actionable fact about a row.
    recurring: ReadonlyMap<string, number>;
    // Fill the parent instead of sizing an inline band: what the full-screen dialog wants.
    fill?: boolean;
}>();
// Row owns the dialog; the canvas only asks. A filled instance already has the window, no button needed.
defineEmits<{ expand: [] }>();

// Traced job id (e.g. '2:1'), not a card id: a card holds several jobs. Hover previews on top of a pinned focus;
// leaving the pointer restores the pin.
const pinned = ref<string | undefined>();
const hovered = ref<string | undefined>();
const focus = computed(() => hovered.value ?? pinned.value);
const pin = (id: string): void => {
    pinned.value = pinned.value === id ? undefined : id;
};

const dag = computed(() => pipelineDag(stages, focus.value));

// Costs multiply across columns and stacked rows, so these stay tighter than a text card's padding; a list of jobs
// doesn't need a paragraph's air.
const NODE_WIDTH = 192;
const JOB_ROW_HEIGHT = 28;
// Split over the card's two ends, so a single-job card isn't text jammed against its border.
const CARD_PADDING_Y = 12;
// Layout spacing: between columns and between stacked cards; the band-height calc below counts both in too.
const RANK_SEP = 72;
const NODE_SEP = 24;

// A card is its rows: dagre is told this per node rather than being handed one size for all of them.
const cardHeight = (cluster: PipelineJobCluster): number => cluster.jobs.length * JOB_ROW_HEIGHT + CARD_PADDING_Y;

const sizedNodes = computed<DagNode<PipelineJobCluster>[]>(() =>
    dag.value.nodes.map((node) => ({ ...node, width: NODE_WIDTH, height: cardHeight(node.data) })),
);

// Inline band height matches the diagram's rendered height at its fitted zoom, plus padding; never excess whitespace
// around a shallow run.
const PAD_X = 0.04;
const PAD_Y_PX = 16;

const root = ref<HTMLElement>();
const containerWidth = ref<number>(0);
let resizeObserver: ResizeObserver | undefined;

onMounted(() => {
    if (root.value) {
        containerWidth.value = root.value.clientWidth;
        if (typeof ResizeObserver !== `undefined`) {
            resizeObserver = new ResizeObserver(([entry]) => {
                if (entry) {
                    containerWidth.value = entry.contentRect.width;
                }
            });
            resizeObserver.observe(root.value);
        }
    }
});

onBeforeUnmount(() => {
    resizeObserver?.disconnect();
});

const bandHeight = computed(() => {
    const columns = new Map<number, number>();
    for (const node of dag.value.nodes) {
        const stage = stageOfNode(node.id);
        const stacked = columns.get(stage);
        columns.set(stage, stacked === undefined ? cardHeight(node.data) : stacked + NODE_SEP + cardHeight(node.data));
    }
    const contentHeight = Math.max(...columns.values(), 0);
    if (contentHeight === 0) {
        return 72;
    }
    const columnCount = Math.max(...columns.keys(), -1) + 1;
    const contentWidth = columnCount * NODE_WIDTH + Math.max(0, columnCount - 1) * RANK_SEP;

    const availableWidth = Math.max(100, (containerWidth.value || 1000) * (1 - 2 * PAD_X));
    const fitZoom = contentWidth > 0 ? Math.min(1, availableWidth / contentWidth) : 1;

    const LEGIBLE_FIT = 0.45;
    const READABLE_ZOOM = 0.8;
    const activeZoom = fitZoom >= LEGIBLE_FIT ? fitZoom : READABLE_ZOOM;

    const renderedHeight = contentHeight * activeZoom;
    return Math.min(520, Math.ceil(renderedHeight + 2 * PAD_Y_PX));
});

const fitPadding = computed(() => {
    if (fill) {
        return { x: PAD_X, y: 0.04 };
    }
    const padY = Math.max(0.01, PAD_Y_PX / bandHeight.value);
    return { x: PAD_X, y: padY };
});

const toneOf = (job: PipelineJob): StatusTone => STATUS_TONE[job.status];

// Translates between DagGraph's card-id selection and the job-id focus above. A click on a card's own margin pins its
// first row, not an untraced card.
const pinnedCard = computed<string | undefined>({
    get: () => dag.value.nodes.find((node) => node.data.jobs.some((member) => member.id === pinned.value))?.id,
    set: (id) => {
        pinned.value = id === undefined ? undefined : dag.value.nodes.find((node) => node.id === id)?.data.jobs[0]?.id;
    },
});

// Lights the whole card, not the hovered row: cluster members share every edge, so the trace is a fact about the card.
// Precision lives in the row's own name.
const focusedCard = computed(() => dag.value.nodes.find((node) => node.data.jobs.some((member) => member.id === focus.value))?.id);
</script>

<template>
    <div
        ref="root"
        class="relative overflow-hidden rounded-lg border border-line bg-canvas"
        :class="fill ? `h-full` : ``"
        :style="fill ? undefined : { height: `${bandHeight}px` }"
    >
        <DagGraph
            v-model="pinnedCard"
            :nodes="sizedNodes"
            :edges="dag.edges"
            :node-width="NODE_WIDTH"
            :node-height="JOB_ROW_HEIGHT + CARD_PADDING_Y"
            :rank-sep="RANK_SEP"
            :node-sep="NODE_SEP"
            edge-shape="elbow"
            :magnify="false"
            :readable-zoom="0.8"
            :min-zoom="0.15"
            :fit-padding="fitPadding"
        >
            <template #node="{ node }">
                <!-- Rows fill the card; pointer events here are how the graph learns which job is hovered. -->
                <div class="relative flex h-full w-full flex-col justify-center py-1.5">
                    <!-- Ring drawn around the whole card, not a single row. -->
                    <span v-if="node.id === focusedCard" class="pointer-events-none absolute inset-0 rounded-md ring-1 ring-inset ring-link"></span>
                    <div
                        v-for="member in node.data.jobs"
                        :key="member.id"
                        class="relative flex items-center gap-2 pl-3 pr-2.5"
                        :class="toneOf(member.job).tint"
                        :style="{ height: `${JOB_ROW_HEIGHT}px` }"
                        @mouseenter="hovered = member.id"
                        @mouseleave="hovered = undefined"
                        @click.stop="pin(member.id)"
                    >
                        <!-- Per row, not per card: one red job among green ones is exactly what a reader looks for. -->
                        <span class="pointer-events-none absolute inset-y-0 left-0 w-0.5" :class="toneOf(member.job).bar"></span>
                        <Icon
                            :name="toneOf(member.job).icon"
                            class="shrink-0 text-sm"
                            :spin="toneOf(member.job).spin"
                            :class="toneOf(member.job).text"
                        />
                        <!--
                            Name first, one line: the stage would only repeat the card's own column, and duration needs its own comparison across a
                            fan-out.
                        -->
                        <!-- One size below body text: at the larger size, most names in a 184px card truncated to ellipsis. -->
                        <span
                            class="min-w-0 flex-1 truncate text-2xs font-medium leading-tight"
                            :class="member.job.status === `failed` ? `text-danger` : `text-content`"
                        >
                            {{ member.job.name }}
                        </span>
                        <span
                            v-if="recurring.get(member.job.name)"
                            class="shrink-0 rounded bg-danger/10 px-1 text-3xs font-semibold text-danger"
                            v-tooltip.top="`Failing for ${recurring.get(member.job.name)} runs in a row`"
                            >×{{ recurring.get(member.job.name) }}</span
                        >
                        <span v-if="formatDuration(member.job.durationSeconds)" class="shrink-0 text-3xs tabular-nums text-subtle">
                            {{ formatDuration(member.job.durationSeconds) }}
                        </span>
                    </div>
                </div>
            </template>

            <template #overlay="{ fitAll }">
                <div class="pointer-events-none absolute inset-0">
                    <div
                        class="pointer-events-auto absolute bottom-2 right-2 flex items-center gap-px rounded-md border border-line/50 bg-canvas/90 p-px shadow-sm backdrop-blur-sm"
                    >
                        <button
                            type="button"
                            :class="ui.iconButton(`h-7 w-7`)"
                            aria-label="Fit"
                            v-tooltip.top="`Zoom out until the whole run is in frame`"
                            @click="fitAll()"
                        >
                            <Icon name="collapse-all" class="text-sm" />
                        </button>
                        <button
                            v-if="!fill"
                            type="button"
                            :class="ui.iconButton(`h-7 w-7`)"
                            aria-label="Expand"
                            v-tooltip.top="`Open the job graph full screen`"
                            @click="$emit(`expand`)"
                        >
                            <Icon name="expand" class="text-sm" />
                        </button>
                    </div>
                </div>
            </template>
        </DagGraph>
    </div>
</template>
