<script setup lang="ts">
import { Card, DagGraph } from "@intentic/extension-ui";
import type { Workflow } from "@intentic/sandbox-contract";
import { computed } from "vue";
import WorkflowNodeCard from "./WorkflowNodeCard.vue";
import { workflowDag, workflowLayers } from "./workflowDag";

/* ONE WORKFLOW AS A CARD, and the SAME card whether it is a design you have saved or a template you could.
 *
 * That is why this is a component rather than two blocks of markup. The gallery under the list used to be a
 * differently-shaped box holding a differently-shaped sentence, and nothing about it said "this is one of
 * those", which is precisely what a template is. Drawn identically (dashed, because you do not own it yet), it
 * reads as a workflow you do not have, and picking one stops being a leap.
 *
 * IT DRAWS THE ACTUAL GRAPH: dagre, the real edges, the same node card the designer and the run view draw:
 * and not a diagram-shaped ornament. It had one of those for a while: chips in columns joined by chevrons,
 * which is a drawing OF a graph rather than the graph, and it quietly dropped everything the picture is worth
 * having for. The continued handoff that draws solid and tinted where a fresh one draws dashed: the one
 * structural fact you cannot read off the titles: was not in it, and neither was what each step produces or
 * what checks it. Feeding `workflowDag` to <DagGraph> makes this a third consumer of the one derivation
 * (workflowDag.ts) rather than a second, lookalike picture of the same workflow, and the frame it sits in is
 * the documentation figure's: a tint, bounded, sized to its content.
 *
 * The description is a PROP rather than read off the workflow, because the gallery sells with a different
 * sentence than the design carries: a template's pitch is about its shape, a saved design's is about its job.
 */

const { workflow, description, dashed = false } = defineProps<{ workflow: Workflow; description?: string; dashed?: boolean }>();
const emit = defineEmits<{ open: [] }>();

const dag = computed(() => workflowDag(workflow));
const layers = computed(() => workflowLayers(workflow.steps));
const widest = computed(() => Math.max(...layers.value.map((layer) => layer.length)));

// The designer's own geometry, so a step is the same box here as it is on the canvas you open by clicking it.
const NODE_WIDTH = 216;
const NODE_HEIGHT = 56;
// dagre's `nodesep` (dagLayout.ts): the gap between two boxes sharing a rank.
const NODE_GAP = 28;

/* How tall the frame has to be, and it is the WIDEST PARALLEL LAYER that decides it: an LR graph grows sideways
 * as steps follow one another and downwards only where they run side by side, so a nine-step chain is no taller
 * than a one-step one. Bounded at both ends for the reason MarkdownFigure bounds a document's figures: a lone
 * box in a 20rem band is a field of nothing, and past the ceiling the graph is scaled down to fit rather than
 * the card growing without limit. The `+2` is room for the fit's own padding.
 */
const frameRem = computed(() => Math.min(20, Math.max(6, (widest.value * NODE_HEIGHT + (widest.value - 1) * NODE_GAP) / 16 + 2)));

/* The two facts the picture cannot carry: how big it is, and how much of it happens at once. `maxParallel` is
 * only said where there is a fan-out to hold back: on a chain it is a number about nothing.
 */
const shape = computed(() => {
    const steps = `${workflow.steps.length} step${workflow.steps.length === 1 ? `` : `s`}`;
    return widest.value > 1 ? `${steps} · up to ${workflow.maxParallel} at once` : steps;
});
</script>

<template>
    <!-- `group/card` is what the quiet actions hang off: Run is always there, edit and delete appear under the
         pointer (see the list). -->
    <Card :dashed="dashed" class="group/card flex flex-col gap-3">
        <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
                <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <button type="button" class="cursor-pointer truncate text-sm font-semibold text-content hover:underline" @click="emit(`open`)">
                        {{ workflow.name }}
                    </button>
                    <slot name="badges" />
                </div>
                <!-- Two lines, and clamped rather than truncated to one: a workflow's description is the only
                     place it says what it is FOR, and a sentence cut off at the width left over by four
                     controls was being shown without being readable. -->
                <p v-if="description" class="mt-1 line-clamp-2 text-xs leading-snug text-muted">{{ description }}</p>
            </div>
            <div class="flex shrink-0 items-center gap-1"><slot name="actions" /></div>
        </div>

        <!-- THE DIAGRAM, in the documentation figure's frame: a wash rather than a stroke, because the picture
             inside is already a field of bordered boxes and an outline around it makes a box of boxes. -->
        <div class="relative w-full overflow-hidden rounded-lg bg-content/4" :style="{ height: `${frameRem}rem` }">
            <!-- A PICTURE, NOT A CANVAS. The graph keeps its own wheel-zoom and drag-pan, which on a page of
                 cards means scrolling past one zooms it instead, so the whole thing is made inert and the
                 gestures go to the page. Panning a thumbnail was never the point; opening it is. -->
            <div class="pointer-events-none h-full w-full">
                <DagGraph :nodes="dag.nodes" :edges="dag.edges" :node-width="NODE_WIDTH" :node-height="NODE_HEIGHT" :magnify="false">
                    <template #node="{ node }"><WorkflowNodeCard :node="node.data" /></template>
                </DagGraph>
            </div>
            <!-- The door, laid over the picture rather than wrapped around it: the nodes are buttons, and a
                 button inside a button is not markup a browser has to honour. -->
            <button
                type="button"
                class="absolute inset-0 cursor-pointer rounded-lg transition-shadow hover:ring-1 hover:ring-line-strong focus-visible:ring-1 focus-visible:ring-link focus-visible:outline-none"
                :aria-label="`Open ${workflow.name} in the designer`"
                @click="emit(`open`)"
            ></button>
        </div>

        <!-- The footer is anchored at both ends: what the design IS on the left, how it last WENT on the right
            , so a column of cards has two things to scan down instead of one ragged line of grey. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
            <span>{{ shape }}</span>
            <div v-if="$slots[`meta`]" class="ml-auto flex items-center gap-3"><slot name="meta" /></div>
        </div>
    </Card>
</template>
