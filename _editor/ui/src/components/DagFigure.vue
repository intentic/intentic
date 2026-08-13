<!-- A ```dag fence, drawn — one branch of MarkdownFigure's switch, living in a file of its own because it is the
     one figure kind heavy enough to be worth loading only when a document actually holds one.

     Under it is a graph canvas: Vue Flow plus dagre, and a stylesheet import that no bundler will drop. Reached
     statically from the prose surface, that lands in every bundle that can render prose — measured on the page a
     shared conversation is published as, which a stranger downloads to read someone's transcript, it was a fifth
     of a megabyte for a canvas almost no conversation contains. So MarkdownFigure imports this file lazily, on
     mermaid's rule (mermaidRender.ts) and Shiki's (code.ts): the first document that holds one pays, the many
     that do not never see it.

     The author supplies meaning; this file and dagre supply the picture. Nothing here reads a coordinate, a
     colour or a size from the document — that is the whole reason figures are data instead of HTML. -->
<script setup lang="ts">
import { computed } from "vue";
import type { DagFigure } from "../markdown/figures.js";
import type { DagEdge, DagNode } from "./dagLayout.js";
import DagGraph from "./DagGraph.vue";
import { seriesColor } from "./seriesAccent.js";

const { figure } = defineProps<{ figure: DagFigure }>();

interface NodeData {
    readonly label: string;
    readonly note: string | undefined;
    readonly swatch: string;
}

const nodes = computed<DagNode<NodeData>[]>(() =>
    figure.nodes.map((node) => ({
        id: node.id,
        data: { label: node.label, note: node.note, swatch: seriesColor(node.accent) },
        // The id is the stable name the rest of the document (and the author) refers to the box by, and it is
        // often the package path the label paraphrases — worth having on hover.
        tooltip: node.id,
    })),
);

const edges = computed<DagEdge[]>(() => figure.edges.map((edge) => ({ from: edge.from, to: edge.to, dashed: edge.dashed })));

/* A prose column cannot host a pannable canvas of unknown height, so the figure gets a fixed one and DagGraph
 * fits its content into it. Scaled to the node count rather than fixed: a three-box diagram in a 24rem frame is
 * mostly empty space, and a twenty-box diagram in one is unreadable. Bounded at both ends — past the ceiling the
 * graph is pannable, which is what the canvas is for.
 *
 * It is computed from the FIGURE, not measured from the canvas, which is also what makes the lazy load invisible:
 * the frame stands at its final height before the graph inside it has arrived, so nothing on the page moves. */
const height = computed(() => Math.min(30, Math.max(12, figure.nodes.length * 3.5)));
</script>

<template>
    <figure class="my-4 flex flex-col gap-2">
        <figcaption v-if="figure.title !== undefined" class="text-xs font-medium text-content">{{ figure.title }}</figcaption>
        <!-- DagGraph requires its parent to size it (single root, h-full w-full). The frame is a tint and not a
             stroke: the diagram inside is already a field of bordered boxes, and an outline around it turned a
             figure into a box of boxes. A wash off the text colour lifts the same area in both schemes. -->
        <div class="w-full rounded-lg bg-content/[0.04]" :style="{ height: `${height}rem` }">
            <DagGraph :nodes="nodes" :edges="edges" :direction="figure.direction" :node-height="56">
                <template #node="{ node }">
                    <div class="flex h-full items-center gap-2 px-2.5">
                        <!-- Identity is a colour BESIDE the text, never the text's own colour: the palette's
                             lighter slots are illegible as type on this surface. -->
                        <span class="size-2 shrink-0 rounded-full" :style="{ background: node.data.swatch }" />
                        <span class="flex min-w-0 flex-col">
                            <span class="truncate text-xs font-medium text-content">{{ node.data.label }}</span>
                            <span v-if="node.data.note !== undefined" class="truncate text-2xs text-muted">{{ node.data.note }}</span>
                        </span>
                    </div>
                </template>
            </DagGraph>
        </div>
    </figure>
</template>
