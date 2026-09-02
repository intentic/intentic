<script setup lang="ts">
import type { PipelineJob } from "@intentic/sandbox-contract";
import { DagGraph, Icon, ui, type DagNode } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { pipelineDag, type PipelineJobCluster, type PipelineStage, stageOfNode } from "./pipelineDag";
import { formatDuration, STATUS_TONE, type StatusTone } from "./statusVisual";

/* THE RUN'S JOB GRAPH: one card per group of identically-wired jobs, laid out left→right in execution order
 * by the same dagre + Vue Flow renderer as the dependency graph (pipelineDag.ts owns where the layering and
 * the grouping come from).
 *
 * IT IS READ, NOT GLANCED AT, and the three things that follow from saying that out loud are the whole design.
 *
 * A CARD IS A GROUP OF JOBS, not a job. Drawing one card per job meant drawing every edge between two stages:
 * a four-job test stage after a two-job build stage is eight arrows that say one thing, and a real workflow
 * crossed into dozens. Jobs whose incoming and outgoing edges are identical are the same story told N times, so
 * they share a card, one row each, and the eight arrows become one. That is also what GitHub's own view does.
 * Nothing is hidden by it: every job is still on screen, with its status, its duration and its failure streak.
 *
 * A FIT NOBODY CAN READ IS NOT A FIT. This band used to hand `fitView` a thirteen-stage run in a strip a
 * thousand pixels wide, which fits at about 0.3×, where the labels are four pixels tall, and then clamped at
 * the zoom floor and quietly cropped the last third of the flow off the right-hand edge. So the canvas asks
 * for a `readableZoom` instead: below it the renderer stops shrinking and shows the START of the run at a size
 * that can be read, which is where a left-to-right flow is read from anyway. `Fit` is on the canvas for the
 * whole shape at a glance, and `Expand` gives it the window. Nothing is cropped without a control that undoes
 * it. And `magnify` is off, because the same fit blew a four-job run up to 2× and drew four billboards.
 *
 * HOVER TRACES THE RUN THROUGH ONE JOB: its card's line lights and takes the ring, the cards that merely ran
 * beside it fade but stay readable. That is the gesture the git log's branch highlight teaches, and it answers
 * the question a fan-out actually provokes: of these five test legs, which one am I looking at, and what did it
 * hold up? A click pins it, so the trace survives the pointer leaving the canvas and exists at all on a touch
 * screen. */

const {
    stages,
    recurring,
    fill = false,
} = defineProps<{
    stages: readonly PipelineStage[];
    // Job name → consecutive runs it has been failing. The single most actionable fact about a row, and until
    // now it lived only in the run row's stage popover: the graph is where someone goes to find out what broke.
    recurring: ReadonlyMap<string, number>;
    // Fill the parent instead of sizing an inline band: what the full-screen dialog wants.
    fill?: boolean;
}>();
// The row owns the dialog, so the canvas only asks. Filling one already has the window and offers no button.
defineEmits<{ expand: [] }>();

/* WHICH JOB THE GRAPH IS TRACING, as a JOB id ("2:1") and not a card id: a card holds several jobs and the
 * question is which one. Hover is the light touch; a click PINS, and the two are one focus with hover on top so
 * that moving the pointer previews without destroying what you pinned, and dropping it restores it. */
const pinned = ref<string | undefined>();
const hovered = ref<string | undefined>();
const focus = computed(() => hovered.value ?? pinned.value);
const pin = (id: string): void => {
    pinned.value = pinned.value === id ? undefined : id;
};

const dag = computed(() => pipelineDag(stages, focus.value));

/* THE CARD'S OWN MEASUREMENTS, and they are the difference between a diagram that fits and one that is panned.
 *
 * A 26-job run is nine columns deep, so every pixel of card width costs nine of picture and every pixel of row
 * height costs six (the tallest column). The first pass used a 216px card of 32px rows with the roomy layout
 * spacing underneath it, which drew this workspace's own CI run 2650px wide: at a zoom that fits, the labels
 * stop resolving; at a zoom that reads, two thirds of the run is off-frame. GitHub's own view of the same run
 * is a third narrower and reads fine, because a card holding a list of jobs is not the same object as a card
 * holding a paragraph, and it does not want the same air. */
const NODE_WIDTH = 192;
const JOB_ROW_HEIGHT = 28;
// Split over the card's two ends, so a single-job card is not a bare strip with text jammed against its border.
const CARD_PADDING_Y = 12;
/* The layout's air: between two columns, and between two cards in one. dagre is told both (see dagLayout.ts) and
 * the band height below counts with them.
 *
 * Cards have breathing room between their stacked rows and surrounding cards; columns have room for
 * turning edges. */
const RANK_SEP = 72;
const NODE_SEP = 24;

// A card is its rows: dagre is told this per node rather than being handed one size for all of them.
const cardHeight = (cluster: PipelineJobCluster): number => cluster.jobs.length * JOB_ROW_HEIGHT + CARD_PADDING_Y;

const sizedNodes = computed<DagNode<PipelineJobCluster>[]>(() =>
    dag.value.nodes.map((node) => ({ ...node, width: NODE_WIDTH, height: cardHeight(node.data) })),
);

/* HOW TALL THE INLINE BAND IS: sized to exactly match the diagram's rendered height at the fitted zoom plus
 * vertical padding, rather than leaving a shallow run floating in excess whitespace. */
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

/* DagGraph's selection is a CARD id, and the focus above is a job id, so the pin is translated both ways:
 * pinning a row rings the card it lives in, and a click landing on the card's own margin, the sliver of
 * padding no row covers, pins its first row rather than ringing a card with no trace drawn from it. */
const pinnedCard = computed<string | undefined>({
    get: () => dag.value.nodes.find((node) => node.data.jobs.some((member) => member.id === pinned.value))?.id,
    set: (id) => {
        pinned.value = id === undefined ? undefined : dag.value.nodes.find((node) => node.id === id)?.data.jobs[0]?.id;
    },
});

/* THE CARD THE TRACE IS DRAWN FROM, which is what the highlight belongs on. It used to be drawn on the ROW under
 * the pointer, on the reasoning that a card holds several jobs and the reader should see which one they are on.
 * That was the wrong end of the argument: cluster members share every edge, so the trace lights the whole card
 * whatever row you enter it by, and a ring around one line of a lit box reads as a glitch rather than as an
 * answer. The job name on the row is where that precision belongs. */
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
                <!-- The rows fill the card, so this is where the graph learns which job the pointer is on. -->
                <div class="relative flex h-full w-full flex-col justify-center py-1.5">
                    <!-- The trace's own card, ringed whole: see focusedCard. -->
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
                        <!-- Status stripe down the row's leading edge: the scannable layer above the text, and
                             per row rather than per card, because one red job in a card of green ones is
                             exactly what a reader is looking for. -->
                        <span class="pointer-events-none absolute inset-y-0 left-0 w-0.5" :class="toneOf(member.job).bar"></span>
                        <Icon
                            :name="toneOf(member.job).icon"
                            class="shrink-0 text-sm"
                            :spin="toneOf(member.job).spin"
                            :class="toneOf(member.job).text"
                        />
                        <!-- One line, name first: the stage only ever repeated the column the card is standing
                             in, and the duration — the thing being compared across a fan-out — was buried in the
                             same grey subtitle. -->
                        <!-- The graph sizes (tokens.css: below 2xs) rather than body text. A job name is read in
                             a card 184px wide with a duration beside it, so at 12px two thirds of this run's
                             names were ellipsis: `verify-core / …`, `release / sand…`. One step down fits them,
                             which is the same trade GitHub's own view makes and the reason theirs reads. -->
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
