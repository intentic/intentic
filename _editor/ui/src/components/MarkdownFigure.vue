<!-- One authored figure → the component that draws it. The switch lives here rather than in Markdown.vue so the
     prose surface stays about prose, and so a new figure kind is one branch in one file.

     The author supplies meaning; this file and dagre supply the picture. Nothing here reads a coordinate, a
     colour or a size from the document — that is the whole reason figures are data instead of HTML. -->
<script setup lang="ts">
import { computed } from "vue";
import type { DagEdge, DagNode } from "./dagLayout.js";
import type { Figure } from "../markdown/figures.js";
import BarChart from "./BarChart.vue";
import DagGraph from "./DagGraph.vue";
import MermaidDiagram from "./MermaidDiagram.vue";
import StatRow from "./StatRow.vue";
import { seriesColor } from "./seriesAccent.js";

const { figure } = defineProps<{ figure: Figure }>();

interface NodeData {
    readonly label: string;
    readonly note: string | undefined;
    readonly swatch: string;
}

const dagNodes = computed<DagNode<NodeData>[]>(() =>
    figure.kind !== `dag`
        ? []
        : figure.nodes.map((node) => ({
              id: node.id,
              data: { label: node.label, note: node.note, swatch: seriesColor(node.accent) },
              // The id is the stable name the rest of the document (and the author) refers to the box by, and
              // it is often the package path the label paraphrases — worth having on hover.
              tooltip: node.id,
          })),
);

const dagEdges = computed<DagEdge[]>(() =>
    figure.kind !== `dag` ? [] : figure.edges.map((edge) => ({ from: edge.from, to: edge.to, dashed: edge.dashed })),
);

/* A prose column cannot host a pannable canvas of unknown height, so the figure gets a fixed one and DagGraph
 * fits its content into it. Scaled to the node count rather than fixed: a three-box diagram in a 24rem frame is
 * mostly empty space, and a twenty-box diagram in one is unreadable. Bounded at both ends — past the ceiling the
 * graph is pannable, which is what the canvas is for. */
const dagHeight = computed(() => (figure.kind !== `dag` ? 0 : Math.min(30, Math.max(12, figure.nodes.length * 3.5))));
</script>

<template>
    <!-- Mermaid draws itself, palette and all (mermaidTheme.ts) — the only figure kind whose picture this file
         does not compose, because the author wrote the diagram in a notation with its own renderer. -->
    <MermaidDiagram v-if="figure.kind === `mermaid`" :code="figure.code" />
    <BarChart v-else-if="figure.kind === `bars`" :items="figure.items" :title="figure.title" />
    <StatRow v-else-if="figure.kind === `stats`" :items="figure.items" />
    <figure v-else class="my-4 flex flex-col gap-2">
        <figcaption v-if="figure.title !== undefined" class="text-xs font-medium text-content">{{ figure.title }}</figcaption>
        <!-- DagGraph requires its parent to size it (single root, h-full w-full). The frame is a tint and not a
             stroke: the diagram inside is already a field of bordered boxes, and an outline around it turned a
             figure into a box of boxes. A wash off the text colour lifts the same area in both schemes. -->
        <div class="w-full rounded-lg bg-content/[0.04]" :style="{ height: `${dagHeight}rem` }">
            <DagGraph :nodes="dagNodes" :edges="dagEdges" :direction="figure.direction" :node-height="56">
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
