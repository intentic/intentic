<!-- A rendered document's parts in reading order: each prose run as sanitized HTML (`.md-run`, prose.css) and each figure
     as its component. Draws no box and binds no listener, so it goes inside the caller's own `.md-prose` container,
     which owns the code-copy and link clicks for everything in it (Markdown.vue, chat's answer and cards). -->
<script setup lang="ts">
import type { MarkdownPart } from "../../markdown/render.js";
import MarkdownFigure from "../charts/MarkdownFigure.vue";

defineProps<{
    // Already sanitized by the markdown pipeline (renderParsedMarkdown); bound as-is.
    parts: readonly MarkdownPart[];
}>();
</script>

<template>
    <!-- Keyed by position: a streaming answer only ever appends, so a settled run keeps its DOM while the tail updates. -->
    <template v-for="(part, index) in parts" :key="index">
        <div v-if="part.kind === `html`" class="md-run" v-html="part.html"></div>
        <MarkdownFigure v-else :figure="part.figure" />
    </template>
</template>
