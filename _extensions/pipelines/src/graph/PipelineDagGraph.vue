<script setup lang="ts">
import type { PipelineJob } from "@intentic/sandbox-contract";
import { DagGraph, Icon, toneTint, toneWash, ui, type DagNode } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { jobName, pipelineDag, type PipelineJobCluster, type PipelineStage, stageOfNode } from "./pipelineDag";
import {
    CALLER_LINE,
    CARD_MAX_WIDTH,
    columnWidths,
    estimateText,
    jobStatusLine,
    type MeasureText,
    NAME_LINE,
    rowHeight,
    STATUS_LINE,
} from "./cardSize";
import { RANK_SEP_MIN, READABLE_ZOOM, spreadColumns } from "./spread";
import { STATUS_TONE, type StatusTone } from "../statusVisual";
import { t } from "../i18n.js";

// Job graph: one card per group of identically-wired jobs, so parallel jobs sharing every edge collapse into one set of
// arrows. A long run is short of width and has height to spare, so a row stacks its lines (see cardSize) and the
// frame's width goes to the gutters between columns, not to margins (see spread). Hover traces one job's card through
// the run; a click pins it. The job name itself is a link out to that job's page on the forge, so the pin stays on the
// plain click everywhere else in the row.

const {
    stages,
    recurring,
    fill = false,
    direction = `LR`,
} = defineProps<{
    stages: readonly PipelineStage[];
    // Job name to consecutive failing runs; the single most actionable fact about a row.
    recurring: ReadonlyMap<string, number>;
    // Fill the parent instead of sizing an inline band: what the full-screen dialog wants.
    fill?: boolean;
    // Which way the stages run. `TB` stacks them for a column narrower than the run is long (the side panel), where
    // left to right would shrink every card past reading; only a filled graph asks for it, the band is sized for `LR`.
    direction?: `LR` | `TB`;
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

// Split over the card's two ends, so a single-job card isn't text jammed against its border.
const CARD_PADDING_Y = 12;
// Between stacked cards in one column.
const NODE_SEP = 24;
// The frame's own margin, px on every side: only enough that a card does not touch the band's border.
const PAD_PX = 16;
// Tallest the inline band grows; a run taller than this at its width's zoom is shrunk to fit it.
const MAX_BAND = 640;

const root = ref<HTMLElement>();
const containerWidth = ref<number>(0);
const containerHeight = ref<number>(0);
let resizeObserver: ResizeObserver | undefined;

// Measures with a hidden probe wearing the rows' own classes, so weight, size and tabular figures are whatever the
// stylesheet says rather than a copy of it; remembered per string, and redone once webfonts land, since a fallback face
// measures a different width.
const PROBE_CLASS: Record<Parameters<MeasureText>[1], string> = {
    label: `text-2xs font-medium`,
    caller: `text-3xs`,
    meta: `text-3xs tabular-nums`,
    badge: `text-3xs font-semibold`,
};
const fontsLoaded = ref(0);
const measure = computed<MeasureText>(() => {
    void fontsLoaded.value;
    const element = root.value;
    if (element === undefined) {
        return estimateText;
    }
    const probe = document.createElement(`span`);
    const known = new Map<string, number>();
    return (text, size) => {
        const key = `${size}:${text}`;
        const cached = known.get(key);
        if (cached !== undefined) {
            return cached;
        }
        probe.className = `pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap ${PROBE_CLASS[size]}`;
        probe.textContent = text;
        element.append(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        known.set(key, width);
        return width;
    };
});

// Recomputed when a hover rebuilds the dag, to the same sizes, so the layout signature holds and nothing reflows.
const widths = computed(() => columnWidths(dag.value.nodes, recurring, measure.value));
const widthOf = (nodeId: string): number => widths.value.get(stageOfNode(nodeId)) ?? CARD_MAX_WIDTH;
// A row's height in its card, which the template sets too, so the box the layout places is the box the rows fill.
const heightOf = (nodeId: string, job: PipelineJob): number => rowHeight(job, widthOf(nodeId), measure.value);
// A card is its rows: the layout is told this per node rather than being handed one size for all of them.
const cardHeight = (node: DagNode<PipelineJobCluster>): number =>
    node.data.jobs.reduce((sum, member) => sum + heightOf(node.id, member.job), CARD_PADDING_Y);

const sizedNodes = computed<DagNode<PipelineJobCluster>[]>(() =>
    dag.value.nodes.map((node) => ({ ...node, width: widthOf(node.id), height: cardHeight(node) })),
);

// The tallest column, cards and the gaps between them: what the band's height and the zoom are measured against.
const contentHeight = computed(() => {
    const columns = new Map<number, number>();
    for (const node of dag.value.nodes) {
        const stage = stageOfNode(node.id);
        const stacked = columns.get(stage);
        columns.set(stage, stacked === undefined ? cardHeight(node) : stacked + NODE_SEP + cardHeight(node));
    }
    return Math.max(...columns.values(), 0);
});

// Zoom and column gutter, solved together for the frame. Top to bottom has no gutter to spread: it keeps the narrowest.
const spread = computed(() => {
    if (direction === `TB`) {
        return { zoom: 1, rankSep: RANK_SEP_MIN, cropped: false };
    }
    const width = containerWidth.value || 1000;
    return spreadColumns({
        cardsWidth: [...widths.value.values()].reduce((sum, columnWidth) => sum + columnWidth, 0),
        columns: widths.value.size,
        contentHeight: contentHeight.value,
        frameWidth: Math.max(100, width - 2 * PAD_PX),
        frameHeight: Math.max(100, (fill ? containerHeight.value || 600 : MAX_BAND) - 2 * PAD_PX),
    });
});

onMounted(() => {
    void document.fonts?.ready.then(() => {
        fontsLoaded.value += 1;
    });
    if (root.value) {
        containerWidth.value = root.value.clientWidth;
        containerHeight.value = root.value.clientHeight;
        if (typeof ResizeObserver !== `undefined`) {
            resizeObserver = new ResizeObserver(([entry]) => {
                if (entry) {
                    containerWidth.value = entry.contentRect.width;
                    containerHeight.value = entry.contentRect.height;
                }
            });
            resizeObserver.observe(root.value);
        }
    }
});

onBeforeUnmount(() => {
    resizeObserver?.disconnect();
});

// Inline band height is the picture's height at its zoom plus the margins and the band's 1px borders; never excess
// whitespace around a shallow run.
const bandHeight = computed(() =>
    contentHeight.value === 0 ? 72 : Math.min(MAX_BAND, Math.ceil(contentHeight.value * spread.value.zoom + 2 * PAD_PX + 2)),
);

// Margins as the fraction of the frame DagGraph takes them in: the same PAD_PX whatever the frame's size.
const fitPadding = computed(() => {
    const width = containerWidth.value || 1000;
    const height = fill ? containerHeight.value || 600 : bandHeight.value - 2;
    return { x: Math.min(0.2, PAD_PX / width), y: Math.min(0.2, PAD_PX / height) };
});

const toneOf = (job: PipelineJob): StatusTone => STATUS_TONE[job.status];
// Wash behind a job row: its outcome's tone, faintly. A row draws no border of its own (DagGraph owns the card's), so
// only the tint's fill shows; a status with no outcome leaves the card's fill alone.
const tintOf = (job: PipelineJob): string => {
    const tone = toneOf(job).variant;
    return tone === `neutral` ? `bg-transparent` : toneTint(tone, `soft`);
};

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
            :node-width="CARD_MAX_WIDTH"
            :node-height="CARD_PADDING_Y + NAME_LINE + STATUS_LINE"
            :rank-sep="spread.rankSep"
            :node-sep="NODE_SEP"
            edge-shape="elbow"
            :direction="direction"
            :magnify="false"
            :readable-zoom="READABLE_ZOOM"
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
                        class="relative flex flex-col justify-center pl-2.5 pr-2"
                        :class="tintOf(member.job)"
                        :style="{ height: `${heightOf(node.id, member.job)}px` }"
                        @mouseenter="hovered = member.id"
                        @mouseleave="hovered = undefined"
                        @click.stop="pin(member.id)"
                    >
                        <!-- Per row, not per card: one failed job among passing ones is exactly what a reader looks for. -->
                        <span class="pointer-events-none absolute inset-y-0 left-0 w-0.5" :class="toneOf(member.job).bar"></span>
                        <!-- The calls a called workflow's job came through, above its own name rather than before it. -->
                        <span
                            v-if="jobName(member.job.name).caller"
                            class="truncate text-3xs text-subtle"
                            :style="{ lineHeight: `${CALLER_LINE}px` }"
                        >
                            {{ jobName(member.job.name).caller }}
                        </span>
                        <!-- One size below body text; wraps rather than widening the card, and the whole name is on its tooltip. -->
                        <!-- The name alone is the link, so the rest of the row keeps the click that traces this job through the run. -->
                        <a
                            v-if="member.job.webUrl"
                            :href="member.job.webUrl"
                            target="_blank"
                            rel="noopener"
                            draggable="false"
                            class="line-clamp-2 break-words rounded-xs text-2xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-link"
                            :class="member.job.status === `failed` ? `text-danger` : `text-content hover:text-link`"
                            :style="{ lineHeight: `${NAME_LINE}px` }"
                            v-tooltip.top="{ title: t(`tip.openLog`), rows: [{ label: t(`tip.job`), value: member.job.name }] }"
                            @click.stop
                        >
                            {{ jobName(member.job.name).title }}
                        </a>
                        <!-- No page of its own: a job the workflow declares that the run never reported, as GitHub draws it. -->
                        <span
                            v-else
                            class="line-clamp-2 break-words text-2xs font-medium"
                            :class="member.job.status === `failed` ? `text-danger` : `text-content`"
                            :style="{ lineHeight: `${NAME_LINE}px` }"
                            v-tooltip.top="jobName(member.job.name).caller ? member.job.name : undefined"
                        >
                            {{ jobName(member.job.name).title }}
                        </span>
                        <!-- Status under the name, not before it: the icon's column was width a long run is short of. -->
                        <span class="flex items-center gap-1 whitespace-nowrap" :style="{ height: `${STATUS_LINE}px` }">
                            <Icon
                                :name="toneOf(member.job).icon"
                                class="shrink-0 text-xs"
                                :spin="toneOf(member.job).spin"
                                :class="toneOf(member.job).text"
                                v-tooltip.top="toneOf(member.job).label"
                            />
                            <span
                                v-if="jobStatusLine(member.job, recurring).streak"
                                :class="toneWash(`danger`, `rounded px-1 text-3xs font-semibold`)"
                                v-tooltip.top="{
                                    title: t(`tip.failingStreak`),
                                    tone: `danger`,
                                    rows: [{ label: t(`tip.runs`), value: jobStatusLine(member.job, recurring).streak ?? `` }],
                                }"
                                >×{{ jobStatusLine(member.job, recurring).streak }}</span
                            >
                            <span class="text-3xs tabular-nums text-subtle">{{ jobStatusLine(member.job, recurring).text }}</span>
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
                            :class="ui.iconButton({ size: `md` })"
                            :aria-label="t(`pipelineDagGraph.fit`)"
                            v-tooltip.top="t(`pipelineDagGraph.fitAll`)"
                            @click="fitAll()"
                        >
                            <Icon name="collapse-all" class="text-sm" />
                        </button>
                        <button
                            v-if="!fill"
                            type="button"
                            :class="ui.iconButton({ size: `md` })"
                            :aria-label="t(`pipelineDagGraph.expand`)"
                            v-tooltip.top="t(`pipelineDagGraph.fullScreen`)"
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
