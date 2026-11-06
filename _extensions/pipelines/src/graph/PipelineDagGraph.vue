<script setup lang="ts">
import type { PipelineJob } from "@intentic/sandbox-contract/schemas/ci";
import { DagGraph, Icon, SegmentedControl, toneTint, toneWash, ui, type DagNode } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { jobName, pipelineDag, type PipelineJobCluster, type PipelineStage, stageOfNode } from "./pipelineDag";
import {
    CALLER_LINE,
    CARD_MAX_WIDTH,
    columnWidths,
    estimateText,
    HEADER_LINE,
    jobLineHeight,
    jobStatusLine,
    type MeasureText,
    NAME_LINE,
    nameLines,
    ownCaller,
    ROW_CARD_MAX_WIDTH,
    rowCardRows,
    rowCardWidths,
    rowHeight,
    sharedCaller,
    STATUS_LINE,
    textsAsked,
} from "./cardSize";
import { useGraphLayout } from "./graphLayout";
import { READABLE_ZOOM, ROW_GAP, spreadColumns, spreadRows } from "./spread";
import { STATUS_TONE, type StatusTone } from "../statusVisual";
import { t } from "../i18n.js";

// Job graph: one card per group of identically-wired jobs, so parallel jobs sharing every edge collapse into one set of
// arrows. Two layouts, switched from the strip above the graph and remembered (graphLayout):
// - columns: stages left to right, as the forge draws a run. A long run is short of width and has height to spare, so a
//   job stacks its lines (see cardSize) and the frame's width goes to the gutters between columns (see spread).
// - rows: stages top to bottom, each job one line, the run drawn whole and as tall as it is, so the page scrolls
//   through it rather than the wheel zooming a band. Width is what a row is short of, so a stage wider than the frame
//   wraps onto another line (DagGraph's `wrapAt`) rather than shrinking every name to fit.
// Lines sweep from card to card in S-curves (DagGraph's `smooth`), changing lane only mid-gutter. The layout keeps them
// off the cards: an edge another path already implies is not drawn (pipelineDag), a long one gets a lane reserved in
// every stage it passes, and each stage is ordered to cross as few lines as it can (dagLayered).
// Hover traces one job's card through the run; a click pins it. The job name itself is a link out to that job's page on
// the forge, so the pin stays on the plain click everywhere else in the row.

const {
    stages,
    recurring,
    fill = false,
    direction,
} = defineProps<{
    stages: readonly PipelineStage[];
    // Job name to consecutive failing runs; the single most actionable fact about a row.
    recurring: ReadonlyMap<string, number>;
    // Fill the parent instead of sizing an inline band: what the full-screen dialog wants.
    fill?: boolean;
    // Which way the stages run, held there whatever the reader picked: `TB` for a column narrower than the run is long
    // (the side panel), where left to right would shrink every card past reading. Unset, the graph runs the way the
    // reader's layout switch says, and draws that switch.
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

const layout = useGraphLayout();
const rows = computed(() => (direction ?? (layout.value === `rows` ? `TB` : `LR`)) === `TB`);
// The shape of each layout is its icon; the word says which, the tip which way it reads.
const layoutOptions = computed(() => [
    { label: t(`pipelineDagGraph.columns`), value: `columns` as const, icon: `flow-columns` as const, title: { title: t(`pipelineDagGraph.leftToRight`) } },
    { label: t(`pipelineDagGraph.rows`), value: `rows` as const, icon: `flow-rows` as const, title: { title: t(`pipelineDagGraph.topToBottom`) } },
]);

// Split over the card's two ends, plus its two 1px borders, so the rows keep their full allocated height.
const CARD_PADDING_Y = 12 + 2;
// Between stacked cards in one column, or side by side in one row.
const NODE_SEP = 24;
// The frame's own margin, px on every side: only enough that a card does not touch the band's border.
const PAD_PX = 16;
// Tallest the inline band grows; a run taller than this at its width's zoom is shrunk to fit it.
const MAX_BAND = 640;

const root = ref<HTMLElement>();
// The canvas's own box, under the strip: what the zoom is solved for and a filled graph's height is read off.
const frame = ref<HTMLElement>();
const graph = ref<{ fitAll: () => void }>();
const containerWidth = ref<number>(0);
const containerHeight = ref<number>(0);
let resizeObserver: ResizeObserver | undefined;
let sizeFrame = 0;

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
const fontLoaded = (): void => {
    fontsLoaded.value += 1;
};
// A graph mounted out of sight (a view kept alive behind another, a row opened while its tab was hidden) has no layout
// to measure in, and every name would come back as nothing wide: it is estimated until its frame has a width, then
// measured for real.
const laidOut = computed(() => containerWidth.value > 0);
interface Measurer {
    readonly text: MeasureText;
    // Measures every string given that is not known yet, all in one layout.
    readonly prime: (texts: readonly (readonly [string, Parameters<MeasureText>[1]])[]) => void;
}
const ESTIMATED: Measurer = { text: estimateText, prime: () => undefined };
const measure = computed<Measurer>(() => {
    void fontsLoaded.value;
    const element = root.value;
    if (element === undefined || !laidOut.value) {
        return ESTIMATED;
    }
    const known = new Map<string, number>();
    // Measured as nothing wide (hidden after all): not remembered, so it is estimated now and measured by the next
    // batch, and not measured again one at a time in between.
    const unmeasured = new Set<string>();
    const keyOf = (text: string, size: Parameters<MeasureText>[1]): string => `${size}:${text}`;
    // ONE LAYOUT FOR EVERY STRING. A probe each, put in together and read together: one probe at a time, put in, read
    // and taken out, laid the page out again for every string, and a long run's first draw (in a ResizeObserver
    // callback, or as its jobs' answer landed) spent up to a second in that forced layout.
    const prime: Measurer[`prime`] = (texts) => {
        const missing = texts.filter(([text, size]) => !known.has(keyOf(text, size)));
        if (missing.length === 0) {
            return;
        }
        const batch = document.createElement(`div`);
        batch.className = `pointer-events-none invisible absolute left-0 top-0`;
        const probes = missing.map(([text, size]) => {
            const probe = document.createElement(`span`);
            probe.className = `absolute left-0 top-0 whitespace-nowrap ${PROBE_CLASS[size]}`;
            probe.textContent = text;
            return probe;
        });
        batch.append(...probes);
        element.append(batch);
        // A dialog opening scales its content for a moment, and a string measured then comes back that much short,
        // enough to cut a name that fits: the scale is read off the root's own box and taken back out.
        const drawn = element.getBoundingClientRect().width;
        const scale = drawn > 0 && element.offsetWidth > 0 ? drawn / element.offsetWidth : 1;
        const measured = probes.map((probe) => probe.getBoundingClientRect().width / scale);
        batch.remove();
        for (const [at, [text, size]] of missing.entries()) {
            const key = keyOf(text, size);
            const width = measured[at] ?? 0;
            if (width > 0 || text === ``) {
                known.set(key, width);
                unmeasured.delete(key);
            } else {
                unmeasured.add(key);
            }
        }
    };
    const one: MeasureText = (text, size) => {
        const key = keyOf(text, size);
        if (!known.has(key) && !unmeasured.has(key)) {
            prime([[text, size]]);
        }
        return known.get(key) ?? estimateText(text, size);
    };
    return { text: one, prime };
});
// A sizing pass run once on estimates to learn the strings it measures, which are then measured together, and once
// for real.
const sized = <T>(pass: (text: MeasureText) => T): T => {
    const measurer = measure.value;
    measurer.prime(textsAsked(pass));
    return pass(measurer.text);
};

// Recomputed when a hover rebuilds the dag, to the same sizes, so the layout signature holds and nothing reflows.
// Columns share one width per column, so the gutter between two is one straight band; a row's cards each fit their own.
const widths = computed(() => sized((text) => columnWidths(dag.value.nodes, recurring, text)));
const rowWidths = computed(() => sized((text) => rowCardWidths(dag.value.nodes, recurring, text)));
const widthOf = (nodeId: string): number =>
    rows.value ? (rowWidths.value.get(nodeId) ?? ROW_CARD_MAX_WIDTH) : (widths.value.get(stageOfNode(nodeId)) ?? CARD_MAX_WIDTH);
// A job's height in its card, which the template sets too, so the box the layout places is the box the rows fill.
const heightOf = (node: DagNode<PipelineJobCluster>, job: PipelineJob): number =>
    rows.value ? jobLineHeight(job, node.data) : rowHeight(job, widthOf(node.id), measure.value.text);
// A card is its rows: the layout is told this per node rather than being handed one size for all of them.
const cardHeight = (node: DagNode<PipelineJobCluster>): number =>
    rows.value ? CARD_PADDING_Y + rowCardRows(node.data) : node.data.jobs.reduce((sum, member) => sum + heightOf(node, member.job), CARD_PADDING_Y);

// Each stage's cards, in the order the layout ranks them.
const ranks = computed(() => {
    const byStage = new Map<number, DagNode<PipelineJobCluster>[]>();
    for (const node of dag.value.nodes) {
        const stage = stageOfNode(node.id);
        byStage.set(stage, [...(byStage.get(stage) ?? []), node]);
    }
    return [...byStage.values()].map((members) => members.toSorted((one, other) => (one.order ?? 0) - (other.order ?? 0)));
});

const sizedNodes = computed<DagNode<PipelineJobCluster>[]>(() => dag.value.nodes.map((node) => ({ ...node, width: widthOf(node.id), height: cardHeight(node) })));

// Rows: the frame's width at full size, where a stage's cards wrap onto another line. In steps, so a pane dragged a
// pixel at a time does not lay the graph out again at every pixel.
const WRAP_STEP = 16;
const wrapAt = computed(() => (rows.value ? Math.max(100, Math.floor(((containerWidth.value || 1000) - 2 * PAD_PX) / WRAP_STEP) * WRAP_STEP) : undefined));

// The picture's box as the layout placed it (the lines it reserves room for beside the cards included), which is
// what the band and the zoom are measured against. Until the graph has laid out once, an estimate: the tallest column,
// or every stage's tallest card and the gutters between, and the widest stage.
// Kept with the layout it was placed in, so a switch reads the estimate until the new layout reports.
const reported = ref<{ readonly rows: boolean; readonly width: number; readonly height: number } | undefined>();
const placed = computed(() => (reported.value?.rows === rows.value ? reported.value : undefined));
const contentHeight = computed(() => {
    if (placed.value !== undefined) {
        return placed.value.height;
    }
    if (rows.value) {
        const tallest = ranks.value.map((members) => Math.max(...members.map(cardHeight)));
        return tallest.reduce((sum, height) => sum + height, 0) + Math.max(0, tallest.length - 1) * ROW_GAP;
    }
    return Math.max(...ranks.value.map((members) => members.reduce((sum, node) => sum + cardHeight(node), 0) + (members.length - 1) * NODE_SEP), 0);
});
const contentWidth = computed(
    () =>
        placed.value?.width ??
        Math.min(
            wrapAt.value ?? Number.POSITIVE_INFINITY,
            Math.max(...ranks.value.map((members) => members.reduce((sum, node) => sum + widthOf(node.id), 0) + (members.length - 1) * NODE_SEP), 0),
        ),
);

// Zoom and gutter, solved for the frame: a column layout spreads its gutters across the width; a row layout keeps one
// gutter and is shown whole at the width's zoom.
const spread = computed(() => {
    const width = containerWidth.value || 1000;
    if (rows.value) {
        return spreadRows({ contentWidth: contentWidth.value, frameWidth: Math.max(100, width - 2 * PAD_PX) });
    }
    return spreadColumns({
        cardsWidth: [...widths.value.values()].reduce((sum, columnWidth) => sum + columnWidth, 0),
        columns: widths.value.size,
        contentHeight: contentHeight.value,
        frameWidth: Math.max(100, width - 2 * PAD_PX),
        frameHeight: Math.max(100, (fill ? containerHeight.value || 600 : MAX_BAND) - 2 * PAD_PX),
    });
});

onMounted(() => {
    // A face that lands after this graph was measured (a weight first used here) changes every width it was measured in.
    void document.fonts?.ready.then(fontLoaded);
    document.fonts?.addEventListener(`loadingdone`, fontLoaded);
    if (frame.value) {
        containerWidth.value = frame.value.clientWidth;
        containerHeight.value = frame.value.clientHeight;
        if (typeof ResizeObserver !== `undefined`) {
            // The entry's own box in whole pixels, written on the next frame. The band's height follows its width
            // (bandHeight), so a size written inside the callback resized the very box observed, in the same frame, and
            // the browser gave up on the rest of that frame's notifications ("ResizeObserver loop completed with
            // undelivered notifications"), after laying the page out again under every observer still to run.
            let seen = { width: containerWidth.value, height: containerHeight.value };
            resizeObserver = new ResizeObserver(([entry]) => {
                if (entry === undefined) {
                    return;
                }
                seen = { width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) };
                if (sizeFrame === 0) {
                    sizeFrame = requestAnimationFrame(() => {
                        sizeFrame = 0;
                        // An unchanged number is no change to Vue: nothing recomputes.
                        containerWidth.value = seen.width;
                        containerHeight.value = seen.height;
                    });
                }
            });
            resizeObserver.observe(frame.value);
        }
    }
});

onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    if (sizeFrame !== 0) {
        cancelAnimationFrame(sizeFrame);
    }
    document.fonts?.removeEventListener(`loadingdone`, fontLoaded);
});

// Inline band height is the picture's height at its zoom plus the margins and the band's 1px borders; never excess
// whitespace around a shallow run. Columns stop at MAX_BAND and shrink to it; rows are as tall as the run.
const bandHeight = computed(() => {
    const height = Math.ceil(contentHeight.value * spread.value.zoom + 2 * PAD_PX + 2);
    return contentHeight.value === 0 ? 72 : rows.value ? height : Math.min(MAX_BAND, height);
});

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
    <div ref="root" class="flex flex-col gap-1.5" :class="fill ? `h-full min-h-0` : ``">
        <!-- The graph's own controls, above it rather than over it: a row layout can be taller than the screen, and a
             corner of the canvas is then a place the reader has scrolled away from. -->
        <div class="flex min-w-0 items-center gap-2">
            <SegmentedControl v-if="direction === undefined" v-model="layout" :options="layoutOptions" size="xs" :aria-label="t(`pipelineDagGraph.layout`)" />
            <div class="ml-auto flex shrink-0 items-center gap-px">
                <button
                    type="button"
                    :class="ui.iconButton({ size: `md` })"
                    :aria-label="t(`pipelineDagGraph.fit`)"
                    v-tooltip.top="t(`pipelineDagGraph.fitAll`)"
                    @click="graph?.fitAll()"
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
        <div
            ref="frame"
            class="relative overflow-hidden rounded-lg border border-line bg-canvas"
            :class="fill ? `min-h-0 flex-1` : ``"
            :style="fill ? undefined : { height: `${bandHeight}px` }"
        >
            <!-- A row layout inline is shown whole and as tall as it is, so the wheel goes on scrolling the page over it. -->
            <DagGraph
                ref="graph"
                v-model="pinnedCard"
                :nodes="sizedNodes"
                :edges="dag.edges"
                :node-width="rows ? ROW_CARD_MAX_WIDTH : CARD_MAX_WIDTH"
                :node-height="CARD_PADDING_Y + NAME_LINE + STATUS_LINE"
                :rank-sep="spread.rankSep"
                :node-sep="NODE_SEP"
                edge-shape="smooth"
                :wrap-at="wrapAt"
                @placed="(extent) => (reported = { rows, width: extent.width, height: extent.height })"
                :direction="rows ? `TB` : `LR`"
                :magnify="false"
                :readable-zoom="READABLE_ZOOM"
                :min-zoom="0.15"
                :fit-padding="fitPadding"
                :fit-align="rows ? `start` : `center`"
                :wheel-zoom="fill || !rows"
            >
                <template #node="{ node }">
                    <!-- Rows fill the card; pointer events here are how the graph learns which job is hovered. -->
                    <div class="relative flex h-full w-full flex-col justify-center py-1.5">
                        <!-- Ring drawn around the whole card, not a single row. -->
                        <span v-if="node.id === focusedCard" class="pointer-events-none absolute inset-0 rounded-md ring-1 ring-inset ring-link"></span>
                        <!-- Rows: the call every job here came through, named once above them. -->
                        <span
                            v-if="rows && sharedCaller(node.data)"
                            class="shrink-0 truncate pl-2.5 pr-2 text-3xs text-subtle"
                            :style="{ height: `${HEADER_LINE}px`, lineHeight: `${HEADER_LINE}px` }"
                            v-tooltip.top.overflow="sharedCaller(node.data)"
                        >
                            {{ sharedCaller(node.data) }}
                        </span>
                        <div
                            v-for="member in node.data.jobs"
                            :key="member.id"
                            class="relative flex shrink-0 flex-col justify-center pl-2.5 pr-2"
                            :class="tintOf(member.job)"
                            :style="{ height: `${heightOf(node, member.job)}px` }"
                            @mouseenter="hovered = member.id"
                            @mouseleave="hovered = undefined"
                            @click.stop="pin(member.id)"
                        >
                            <!-- Per row, not per card: one failed job among passing ones is exactly what a reader looks for. -->
                            <span class="pointer-events-none absolute inset-y-0 left-0 w-0.5" :class="toneOf(member.job).bar"></span>
                            <!-- Rows: one line, status first, the name, then its clock at the right edge. -->
                            <template v-if="rows">
                                <span
                                    v-if="ownCaller(member.job, node.data)"
                                    class="shrink-0 truncate pl-4 text-3xs text-subtle"
                                    :style="{ lineHeight: `${CALLER_LINE}px` }"
                                    v-tooltip.top="member.job.name"
                                >
                                    {{ ownCaller(member.job, node.data) }}
                                </span>
                                <span class="flex min-w-0 shrink-0 items-center gap-1 whitespace-nowrap" :style="{ height: `${NAME_LINE}px` }">
                                    <Icon
                                        :name="toneOf(member.job).icon"
                                        class="shrink-0 text-xs"
                                        :spin="toneOf(member.job).spin"
                                        :class="toneOf(member.job).text"
                                        v-tooltip.top="toneOf(member.job).label"
                                    />
                                    <a
                                        v-if="member.job.webUrl"
                                        :href="member.job.webUrl"
                                        target="_blank"
                                        rel="noopener"
                                        draggable="false"
                                        class="min-w-0 truncate rounded-xs text-2xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-link"
                                        :class="member.job.status === `failed` ? `text-danger` : `text-content hover:text-link`"
                                        :style="{ lineHeight: `${NAME_LINE}px` }"
                                        v-tooltip.top="{ title: t(`tip.openLog`), rows: [{ label: t(`tip.job`), value: member.job.name }] }"
                                        @click.stop
                                    >
                                        {{ jobName(member.job.name).title }}
                                    </a>
                                    <span
                                        v-else
                                        class="min-w-0 truncate text-2xs font-medium"
                                        :class="member.job.status === `failed` ? `text-danger` : `text-content`"
                                        :style="{ lineHeight: `${NAME_LINE}px` }"
                                        v-tooltip.top="member.job.name"
                                    >
                                        {{ jobName(member.job.name).title }}
                                    </span>
                                    <span
                                        v-if="jobStatusLine(member.job, recurring).streak"
                                        :class="toneWash(`danger`, `shrink-0 rounded px-1 text-3xs font-semibold`)"
                                        v-tooltip.top="{
                                            title: t(`tip.failingStreak`),
                                            tone: `danger`,
                                            rows: [{ label: t(`tip.runs`), value: jobStatusLine(member.job, recurring).streak ?? `` }],
                                        }"
                                        >×{{ jobStatusLine(member.job, recurring).streak }}</span
                                    >
                                    <span class="ml-auto shrink-0 pl-2 text-3xs tabular-nums text-subtle">{{ jobStatusLine(member.job, recurring).text }}</span>
                                </span>
                            </template>
                            <template v-else>
                                <!-- The calls a called workflow's job came through, above its own name rather than before it. -->
                                <span
                                    v-if="jobName(member.job.name).caller"
                                    class="shrink-0 truncate text-3xs text-subtle"
                                    :style="{ lineHeight: `${CALLER_LINE}px` }"
                                    v-tooltip.top="member.job.name"
                                >
                                    {{ jobName(member.job.name).caller }}
                                </span>
                                <!-- Clamp to the lines the row allocated: an unexpected wrap must not squeeze or clip a line. -->
                                <!-- The name alone is the link, so the rest of the row keeps the click that traces this job through the run. -->
                                <a
                                    v-if="member.job.webUrl"
                                    :href="member.job.webUrl"
                                    target="_blank"
                                    rel="noopener"
                                    draggable="false"
                                    class="shrink-0 rounded-xs text-2xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-link"
                                    :class="[
                                        nameLines(member.job, widthOf(node.id), measure.text) === 1 ? `truncate` : `line-clamp-2 break-words`,
                                        member.job.status === `failed` ? `text-danger` : `text-content hover:text-link`,
                                    ]"
                                    :style="{ lineHeight: `${NAME_LINE}px` }"
                                    v-tooltip.top="{ title: t(`tip.openLog`), rows: [{ label: t(`tip.job`), value: member.job.name }] }"
                                    @click.stop
                                >
                                    {{ jobName(member.job.name).title }}
                                </a>
                                <!-- No page of its own: a job the workflow declares that the run never reported, as GitHub draws it. -->
                                <span
                                    v-else
                                    class="shrink-0 text-2xs font-medium"
                                    :class="[
                                        nameLines(member.job, widthOf(node.id), measure.text) === 1 ? `truncate` : `line-clamp-2 break-words`,
                                        member.job.status === `failed` ? `text-danger` : `text-content`,
                                    ]"
                                    :style="{ lineHeight: `${NAME_LINE}px` }"
                                    v-tooltip.top="member.job.name"
                                >
                                    {{ jobName(member.job.name).title }}
                                </span>
                                <!-- Status under the name, not before it: the icon's column was width a long run is short of. -->
                                <span class="flex min-w-0 shrink-0 items-center gap-1 whitespace-nowrap" :style="{ height: `${STATUS_LINE}px` }">
                                    <Icon
                                        :name="toneOf(member.job).icon"
                                        class="shrink-0 text-xs"
                                        :spin="toneOf(member.job).spin"
                                        :class="toneOf(member.job).text"
                                        v-tooltip.top="toneOf(member.job).label"
                                    />
                                    <span
                                        v-if="jobStatusLine(member.job, recurring).streak"
                                        :class="toneWash(`danger`, `shrink-0 rounded px-1 text-3xs font-semibold`)"
                                        v-tooltip.top="{
                                            title: t(`tip.failingStreak`),
                                            tone: `danger`,
                                            rows: [{ label: t(`tip.runs`), value: jobStatusLine(member.job, recurring).streak ?? `` }],
                                        }"
                                        >×{{ jobStatusLine(member.job, recurring).streak }}</span
                                    >
                                    <span class="min-w-0 truncate text-3xs tabular-nums text-subtle" v-tooltip.top="jobStatusLine(member.job, recurring).text">{{
                                        jobStatusLine(member.job, recurring).text
                                    }}</span>
                                </span>
                            </template>
                        </div>
                    </div>
                </template>
            </DagGraph>
        </div>
    </div>
</template>
