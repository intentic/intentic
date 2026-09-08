<!--
    The design system's one prose surface: sanitized HTML (markdown/render.ts) styled by prose.css, with Shiki-coloured code blocks whose copy
    buttons are wired here. A document with figure fences renders as alternating prose runs and figure components; one without renders as a single
    byte-identical v-html.
-->
<script setup lang="ts">
import { computed } from "vue";
import { copyCodeFromEvent } from "../../markdown/code.js";
import { type MarkdownDecorator, renderMarkdownParts } from "../../markdown/render.js";
import MarkdownFigure from "../charts/MarkdownFigure.vue";

defineOptions({ inheritAttrs: false });

const { source, decorate } = defineProps<{
    // Markdown text. Treated as untrusted: the pipeline sanitizes before this is bound.
    source: string;
    // Optional pass over the sanitized DOM before it renders: the app uses it to linkify file mentions.
    decorate?: MarkdownDecorator;
}>();

// Prose runs and figures, in reading order (see renderMarkdownParts). Every run goes through the same engine
// with the same decorator, so file links and code blocks behave identically either side of a figure.
const parts = computed(() => renderMarkdownParts(source, decorate));

// The whole document as one string when it holds no figures: the shape every existing surface renders in.
const plain = computed(() => {
    const only = parts.value.length === 1 ? parts.value[0] : undefined;
    return only?.kind === `html` ? only.html : undefined;
});
</script>

<template>
    <div v-if="plain !== undefined" v-bind="$attrs" class="md-prose" @click="copyCodeFromEvent" @pointerdown="copyCodeFromEvent" v-html="plain"></div>
    <div v-else v-bind="$attrs" class="md-prose" @click="copyCodeFromEvent" @pointerdown="copyCodeFromEvent">
        <template v-for="(part, index) in parts" :key="index">
            <div v-if="part.kind === `html`" class="md-run" v-html="part.html"></div>
            <MarkdownFigure v-else :figure="part.figure" />
        </template>
    </div>
</template>
