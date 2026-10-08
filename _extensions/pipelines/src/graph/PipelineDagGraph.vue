<script setup lang="ts">
import type { PipelineJob } from "@intentic/sandbox-contract";
import { DagGraph, Icon, toneTint, toneWash, ui, type DagNode } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { jobLabel, pipelineDag, type PipelineJobCluster, type PipelineStage, stageOfNode } from "./pipelineDag";
import { CARD_MAX_WIDTH, columnWidths, estimateText, jobMeta, type MeasureText, META_LINE, NAME_LINE, nameLines, rowHeight } from "./cardSize";
import { formatDuration, STATUS_TONE, type StatusTone } from "../statusVisual";
import { t } from "../i18n.js";

// Job graph: one card per group of identically-wired jobs, so parallel jobs sharing every edge collapse into one set of
// arrows. Below `readableZoom` the canvas stops shrinking rather than crop or blur past legibility. Hover traces one
// job's card through the run; a click pins it. The job name itself is a link out to that job's page on the forge, so
// the pin stays on the plain click everywhere else in the row.

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

// Costs multiply across columns and stacked rows, so these stay tighter than a text card's padding; a list of jobs
// doesn't need a paragraph's air. A card's width is its column's widest name, a row's height its lines (see cardSize).
// Split over the card's two ends, so a single-job card isn't text jammed against its border.
const CARD_PADDING_Y = 12;
// Layout spacing: between columns and between stacked cards; the band-height calc below counts both in too. The column
// gutter only has to hold an elbow's two turns, each half the gutter from a card, so it stays narrow: on a long run it
// is paid once per column.
const RANK_SEP = 32;
const NODE_SEP = 24;

const root = ref<HTMLElement>();
const containerWidth = ref<number>(0);
let resizeObserver: ResizeObserver | undefined;

// Measures with a hidden probe wearing the rows' own classes, so weight, size and tabular figures are whatever the
// stylesheet says rather than a copy of it; remembered per string, and redone once webfonts land, since a fallback face
// measures a different width.
const PROBE_CLASS: Record<Parameters<MeasureText>[1], string> = {
    label: `text-2xs font-medium leading-tight`,
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
    probe.className = `pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap`;
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

// Recomputed when a hover rebuilds the dag, to the same widths, so the layout signature holds and nothing reflows.
const widths = computed(() => columnWidths(dag.value.nodes, recurring, measure.value));
const widthOf = (nodeId: string): number => widths.value.get(stageOfNode(nodeId)) ?? CARD_MAX_WIDTH;
// A row's height in its card, which the template sets too, so the box dagre places is the box the rows fill.
const heightOf = (nodeId: string, job: PipelineJob): number => rowHeight(job, recurring, widthOf(nodeId), measure.value);
// A card is its rows: dagre is told this per node rather than being handed one size for all of them.
const cardHeight = (node: DagNode<PipelineJobCluster>): number =>
    node.data.jobs.reduce((sum, member) => sum + heightOf(node.id, member.job), CARD_PADDING_Y);

const sizedNodes = computed<DagNode<PipelineJobCluster>[]>(() =>
    dag.value.nodes.map((node) => ({ ...node, width: widthOf(node.id), height: cardHeight(node) })),
);

// Inline band height matches the diagram's rendered height at its fitted zoom, plus padding; never excess whitespace
// around a shallow run.
const PAD_X = 0.04;
const PAD_Y_PX = 16;

onMounted(() => {
    void document.fonts?.ready.then(() => {
        fontsLoaded.value += 1;
    });
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
        columns.set(stage, stacked === undefined ? cardHeight(node) : stacked + NODE_SEP + cardHeight(node));
    }
    const contentHeight = Math.max(...columns.values(), 0);
    if (contentHeight === 0) {
        return 72;
    }
    const columnCount = columns.size;
    const contentWidth = [...widths.value.values()].reduce((sum, width) => sum + width, 0) + Math.max(0, columnCount - 1) * RANK_SEP;

    const availableWidth = Math.max(100, (containerWidth.value || 1000) * (1 - 2 * PAD_X));
    const fitZoom = contentWidth > 0 ? Math.min(1, availableWidth / contentWidth) : 1;

    const LEGIBLE_FIT = 0.45;
    const READABLE_ZOOM = 0.8;
    const activeZoom = fitZoom >= LEGIBLE_FIT ? fitZoom : READABLE_ZOOM;

    const renderedHeight = contentHeight * activeZoom;
    // Taller than a one-line row needed: a long run now spends height where it used to spend width.
    return Math.min(600, Math.ceil(renderedHeight + 2 * PAD_Y_PX));
});

const fitPadding = computed(() => {
    if (fill) {
        return { x: PAD_X, y: 0.04 };
    }
    const padY = Math.max(0.01, PAD_Y_PX / bandHeight.value);
    return { x: PAD_X, y: padY };
});

const toneOf = (job: PipelineJob): StatusTone => STATUS_TONE[job.status];
const hasMetaLine = (job: PipelineJob): boolean => {
    const meta = jobMeta(job, recurring);
    return meta.streak !== undefined || meta.duration !== undefined;
};
// The icon sits on the name's first line, wherever the row's lines centre it: half the row's spare height down.
const iconTop = (nodeId: string, job: PipelineJob): number => {
    const lines = nameLines(job, widthOf(nodeId), measure.value) * NAME_LINE + (hasMetaLine(job) ? META_LINE : 0);
    return (heightOf(nodeId, job) - lines) / 2 + (NAME_LINE - 14) / 2;
};
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
            :node-height="28 + CARD_PADDING_Y"
            :rank-sep="RANK_SEP"
            :node-sep="NODE_SEP"
            edge-shape="elbow"
            :direction="direction"
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
                        class="relative flex items-center gap-1.5 pl-2.5 pr-2"
                        :class="tintOf(member.job)"
                        :style="{ height: `${heightOf(node.id, member.job)}px` }"
                        @mouseenter="hovered = member.id"
                        @mouseleave="hovered = undefined"
                        @click.stop="pin(member.id)"
                    >
                        <!-- Per row, not per card: one failed job among passing ones is exactly what a reader looks for. -->
                        <span class="pointer-events-none absolute inset-y-0 left-0 w-0.5" :class="toneOf(member.job).bar"></span>
                        <Icon
                            :name="toneOf(member.job).icon"
                            class="shrink-0 self-start text-sm"
                            :style="{ marginTop: `${iconTop(node.id, member.job)}px` }"
                            :spin="toneOf(member.job).spin"
                            :class="toneOf(member.job).text"
                        />
                        <!-- Name on top, wrapping rather than widening the card; what qualifies it on a line beneath. A long run is
                             short of width and has height to spare, so the row spends the height. -->
                        <div class="flex min-w-0 flex-1 flex-col">
                            <!-- One size below body text: at the larger size, a long run's names wrapped past two lines. -->
                            <!-- The name alone is the link, so the rest of the row keeps the click that traces this job through the run. -->
                            <a
                                v-if="member.job.webUrl"
                                :href="member.job.webUrl"
                                target="_blank"
                                rel="noopener"
                                draggable="false"
                                class="line-clamp-2 break-words rounded-xs text-2xs font-medium leading-tight underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-link"
                                :class="member.job.status === `failed` ? `text-danger` : `text-content hover:text-link`"
                                v-tooltip.top="{ title: t(`tip.openLog`), rows: [{ label: t(`tip.job`), value: member.job.name }] }"
                                @click.stop
                            >
                                {{ jobLabel(member.job.name) }}
                            </a>
                            <!-- No page of its own: a job the workflow declares that the run never reported, as GitHub draws it. -->
                            <span
                                v-else
                                class="line-clamp-2 break-words text-2xs font-medium leading-tight"
                                :class="member.job.status === `failed` ? `text-danger` : `text-content`"
                                v-tooltip.top="jobLabel(member.job.name) === member.job.name ? undefined : member.job.name"
                            >
                                {{ jobLabel(member.job.name) }}
                            </span>
                            <span v-if="hasMetaLine(member.job)" class="flex items-center gap-1.5 whitespace-nowrap leading-snug">
                                <span
                                    v-if="jobMeta(member.job, recurring).streak"
                                    :class="toneWash(`danger`, `rounded px-1 text-3xs font-semibold`)"
                                    v-tooltip.top="{
                                        title: t(`tip.failingStreak`),
                                        tone: `danger`,
                                        rows: [{ label: t(`tip.runs`), value: jobMeta(member.job, recurring).streak ?? `` }],
                                    }"
                                    >×{{ jobMeta(member.job, recurring).streak }}</span
                                >
                                <span v-if="jobMeta(member.job, recurring).duration" class="text-3xs tabular-nums text-subtle">
                                    {{ jobMeta(member.job, recurring).duration }}
                                </span>
                            </span>
                        </div>
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
