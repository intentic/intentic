<!-- One authored figure → the component that draws it. The switch lives here rather than in Markdown.vue so the
     prose surface stays about prose, and so a new figure kind is one branch in one file.

     The author supplies meaning; the components below supply the picture. Nothing here reads a coordinate, a
     colour or a size from the document: that is the whole reason figures are data instead of HTML. -->
<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import type { Figure } from "../markdown/figures.js";
import BarChart from "./BarChart.vue";
import MermaidDiagram from "./MermaidDiagram.vue";
import StatStrip from "./StatStrip.vue";

defineProps<{ figure: Figure }>();

/* The dag is the one branch that is not imported with the rest: it draws on a graph canvas (Vue Flow, dagre and
 * a stylesheet), which is heavier than everything else on this page put together and which most documents never
 * ask for. Loaded on the first one that does: see DagFigure.vue, which also explains why nothing moves on the
 * page while it arrives. */
const DagFigure = defineAsyncComponent(() => import("./DagFigure.vue"));
</script>

<template>
    <!-- Mermaid draws itself, palette and all (mermaidTheme.ts): the only figure kind whose picture this file
         does not compose, because the author wrote the diagram in a notation with its own renderer. -->
    <MermaidDiagram v-if="figure.kind === `mermaid`" :code="figure.code" />
    <BarChart v-else-if="figure.kind === `bars`" :items="figure.items" :title="figure.title" />
    <StatStrip v-else-if="figure.kind === `stats`" :items="figure.items" />
    <DagFigure v-else :figure="figure" />
</template>
