<!-- Renders a ```dag fence as a graph canvas (Vue Flow + dagre); loaded lazily by <MarkdownFigure> since the canvas is heavy and most documents hold none. -->
<script setup lang="ts">
import { computed } from "vue";
import type { DagFigure } from "../../markdown/figures.js";
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
        // often the package path the label paraphrases: worth having on hover.
        tooltip: node.id,
    })),
);

const edges = computed<DagEdge[]>(() => figure.edges.map((edge) => ({ from: edge.from, to: edge.to, dashed: edge.dashed })));

/* DagGraph owns the fixed-height pannable canvas. */
const height = computed(() => Math.min(30, Math.max(12, figure.nodes.length * 3.5)));
</script>

<template>
    <figure class="my-4 flex flex-col gap-2">
        <figcaption v-if="figure.title !== undefined" class="text-xs font-medium text-content">{{ figure.title }}</figcaption>
<!-- DagGraph requires its parent to size it (single root, h-full w-full). -->
        <div class="w-full rounded-lg bg-content/[0.04]" :style="{ height: `${height}rem` }">
            <DagGraph :nodes="nodes" :edges="edges" :direction="figure.direction" :node-height="56">
                <template #node="{ node }">
                    <div class="flex h-full items-center gap-2 px-2.5">
                        <!-- The node identity swatch is separate from the text color for contrast. -->
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
