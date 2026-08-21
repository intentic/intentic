<script setup lang="ts">
import type { PipelineJob } from "@intentic/sandbox-contract";
import { DagGraph, Icon } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { pipelineDag, type PipelineStage, stageOfNode } from "./pipelineDag";
import { formatDuration, STATUS_TONE } from "./statusVisual";

/* THE RUN'S JOB GRAPH: one card per job, laid out left→right in execution order by the same dagre + Vue Flow
 * renderer as the dependency graph (pipelineDag.ts owns where the layering comes from).
 *
 * IT IS READ, NOT GLANCED AT, and the two things that follow from saying that out loud are the whole redesign.
 *
 * A FIT NOBODY CAN READ IS NOT A FIT. This band used to hand `fitView` a thirteen-stage run in a strip a
 * thousand pixels wide, which fits at about 0.3×, where the labels are four pixels tall, and then clamped at
 * the zoom floor and quietly cropped the last third of the flow off the right-hand edge. So the canvas asks
 * for a `readableZoom` instead: below it the renderer stops shrinking and shows the START of the run at a size
 * that can be read, which is where a left-to-right flow is read from anyway. `Fit` is on the canvas for the
 * whole shape at a glance, and `Expand` gives it the window. Nothing is cropped without a control that undoes
 * it. And `magnify` is off, because the same fit blew a four-job run up to 2× and drew four billboards.
 *
 * HOVER TRACES THE RUN THROUGH ONE JOB (onJobLine): its line lights, and the jobs that merely ran beside it in
 * its own stage fade. That is the gesture the git log's branch highlight teaches, and it answers the question
 * a fan-out actually provokes: of these five test legs, which one am I looking at, and what did it hold up? A
 * click pins it, so the trace survives the pointer leaving the canvas and exists at all on a touch screen. */

const {
    stages,
    recurring,
    fill = false,
} = defineProps<{
    stages: readonly PipelineStage[];
    // Job name → consecutive runs it has been failing. The single most actionable fact about a card, and until
    // now it lived only in the row's stage popover: the graph is where someone goes to find out what broke.
    recurring: ReadonlyMap<string, number>;
    // Fill the parent instead of sizing an inline band: what the full-screen dialog wants.
    fill?: boolean;
}>();
// The row owns the dialog, so the canvas only asks. Filling one already has the window and offers no button.
defineEmits<{ expand: [] }>();

/* WHICH JOB THE GRAPH IS TRACING. Hover is the light touch; a click PINS, and the two are one focus with hover
 * on top so that moving the pointer previews without destroying what you pinned, and dropping it restores it. */
const pinned = ref<string | undefined>();
const hovered = ref<string | undefined>();
const focus = computed(() => hovered.value ?? pinned.value);

const dag = computed(() => pipelineDag(stages, focus.value));

const NODE_WIDTH = 216;
const NODE_HEIGHT = 44;
// dagre's in-rank gap (nodesep) is 28: see dagLayout.ts.
const ROW_PITCH = NODE_HEIGHT + 28;

// Size the band to the widest stage, so a two-job pipeline doesn't sit in a half-empty box and a fan-out of
// twenty is pannable rather than crushed. The floor is a canvas rather than the strip this used to be: a
// diagram given 150px reads as a decoration of the row above it.
const bandHeight = computed(() => {
    const widest = stages.reduce((most, stage) => Math.max(most, stage.jobs.length), 1);
    return Math.min(520, Math.max(224, widest * ROW_PITCH + 40));
});

const toneOf = (job: PipelineJob) => STATUS_TONE[job.status];

/* WHAT THE TRACE SAYS IN WORDS, and the reason the cards no longer carry a tooltip. The counts are the
 * sentence someone hovering a failed job came for: "nine jobs waited on this one", and they are the part of
 * the highlight that still works in a screenshot, or for a reader who cannot pick the fading out. Being a
 * fixed corner rather than a popup, it can also afford the job's untruncated name and its stage, which is what
 * the card gave up to fit on one line. */
const caption = computed(() => {
    const id = focus.value;
    if (id === undefined) {
        return undefined;
    }
    const job = dag.value.nodes.find((node) => node.id === id);
    const lineage = dag.value.lineage;
    if (job === undefined || lineage === undefined) {
        return undefined;
    }
    const { before, after } = lineage;
    const line = [before > 0 ? `${before} ran before` : undefined, after > 0 ? `${after} waited on it` : undefined].filter(Boolean).join(` · `);
    return {
        name: job.data.name,
        // Only when the vendor named it: a derived GitHub wave has no name a reader would recognise.
        stage: stages[stageOfNode(id)]?.name,
        line: line === `` ? `the whole run, start to finish` : line,
    };
});
</script>

<template>
    <div
        class="relative overflow-hidden rounded-lg border border-line bg-canvas"
        :class="fill ? `h-full` : ``"
        :style="fill ? undefined : { height: `${bandHeight}px` }"
    >
        <DagGraph
            v-model="pinned"
            :nodes="dag.nodes"
            :edges="dag.edges"
            :node-width="NODE_WIDTH"
            :node-height="NODE_HEIGHT"
            :magnify="false"
            :readable-zoom="0.8"
            :min-zoom="0.15"
        >
            <template #node="{ node }">
                <!-- Status stripe down the card's leading edge: the scannable layer above the text. -->
                <span class="pointer-events-none absolute inset-y-0 left-0 w-0.5" :class="toneOf(node.data).bar"></span>
                <!-- The card the trace is drawn FROM. Without it the gesture only ever says what a job is
                     related to, never which job you are on: every neighbour lights, and the one under the
                     pointer looks like all of them. DagGraph rings a PINNED card; this covers the hover. -->
                <span v-if="node.id === focus" class="pointer-events-none absolute inset-0 rounded-sm ring-1 ring-inset ring-link"></span>
                <!-- The slot fills the card, so this is where the graph learns what the pointer is on. -->
                <span
                    class="flex h-full items-center gap-2 pl-3 pr-2.5"
                    :class="toneOf(node.data).tint"
                    @mouseenter="hovered = node.id"
                    @mouseleave="hovered = undefined"
                >
                    <Icon
                        :name="toneOf(node.data).icon"
                        class="shrink-0 text-sm"
                        :class="[toneOf(node.data).text, toneOf(node.data).spin ? `animate-spin` : ``]"
                    />
                    <!-- One line, name first: the stage used to sit under it and only ever repeated the column
                         the card is standing in, while the duration: the thing being compared across a
                         fan-out: was buried in the same grey subtitle. Both facts stay in the tooltip. -->
                    <span
                        class="min-w-0 flex-1 truncate text-xs font-medium leading-tight"
                        :class="node.data.status === `failed` ? `text-danger` : `text-content`"
                    >
                        {{ node.data.name }}
                    </span>
                    <span
                        v-if="recurring.get(node.data.name)"
                        class="shrink-0 rounded bg-danger/10 px-1 text-2xs font-semibold text-danger"
                        v-tooltip.top="`Failing for ${recurring.get(node.data.name)} runs in a row`"
                        >×{{ recurring.get(node.data.name) }}</span
                    >
                    <span v-if="formatDuration(node.data.durationSeconds)" class="shrink-0 text-2xs tabular-nums text-subtle">
                        {{ formatDuration(node.data.durationSeconds) }}
                    </span>
                </span>
            </template>

            <template #overlay="{ fitAll }">
                <!-- Teaches the gesture while nothing is traced, then gets out of the way and reports it. -->
                <div class="pointer-events-none absolute left-3 top-2.5 max-w-3/4 truncate text-2xs">
                    <template v-if="caption">
                        <span class="font-medium text-content">{{ caption.name }}</span>
                        <span v-if="caption.stage" class="text-subtle"> · {{ caption.stage }}</span>
                        <span class="text-subtle">: {{ caption.line }}</span>
                    </template>
                    <span v-else class="text-subtle">Hover a job to trace its flow · click to pin it</span>
                </div>

                <div class="absolute bottom-2.5 right-2.5 flex items-center gap-1">
                    <button
                        type="button"
                        class="cursor-pointer rounded border border-line bg-canvas/90 px-2 py-1 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                        v-tooltip.top="`Zoom out until the whole run is in frame`"
                        @click="fitAll()"
                    >
                        Fit
                    </button>
                    <button
                        v-if="!fill"
                        type="button"
                        class="cursor-pointer rounded border border-line bg-canvas/90 px-2 py-1 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                        v-tooltip.top="`Open the job graph full screen`"
                        @click="$emit(`expand`)"
                    >
                        <Icon name="expand" class="text-2xs" />
                    </button>
                </div>
            </template>
        </DagGraph>
    </div>
</template>
