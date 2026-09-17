<!-- Dispatches one authored figure fence to the component that draws it. -->
<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import type { Figure } from "../../markdown/figures.js";
import BarChart from "./BarChart.vue";
import MermaidDiagram from "./MermaidDiagram.vue";
import StatStrip from "./StatStrip.vue";

defineProps<{ figure: Figure }>();

/* The dag is the one branch that is not imported with the rest: it draws on a graph canvas (Vue Flow, dagre and a stylesheet). */
const DagFigure = defineAsyncComponent(() => import("./DagFigure.vue"));
</script>

<template>
    <!-- Mermaid draws itself, palette and all (mermaidTheme.ts): the only figure kind whose picture this file does not compose. -->
    <MermaidDiagram v-if="figure.kind === `mermaid`" :code="figure.code" />
    <BarChart v-else-if="figure.kind === `bars`" :items="figure.items" :title="figure.title" />
    <StatStrip v-else-if="figure.kind === `stats`" :items="figure.items" />
    <DagFigure v-else :figure="figure" />
</template>
