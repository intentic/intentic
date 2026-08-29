<!-- Rendered markdown. The design system's ONE prose surface: sanitized HTML (see markdown/render.ts) styled
     by prose.css, with Shiki-coloured fenced blocks whose copy buttons are wired here.

     A component rather than a bare `v-html`, because every caller otherwise has to remember the same three
     things: sanitize before binding, carry the `md-prose` class, and delegate the code-block copy, on the
     press as well as the click, since a re-render between the two loses the button (see copyCodeFromEvent);
     the blocks live inside v-html, so they can hold no component of their own. Extension views get it through
     the kit, so third-party UI renders agent prose exactly like the chat does.

     Type scale and measure come from prose.css's `--prose-*` tokens: set them on this element to tune a
     surface (`style="--prose-measure: 68ch"`); attributes fall through to the root.

     TWO SHAPES, ONE ROOT. A document with figure fences (markdown/figures.ts) cannot be one v-html string:
     a figure is a component. So such a document renders as alternating prose runs and figures, while a document
     without any renders EXACTLY as it always did: one element, one v-html, byte-identical DOM. That is not an
     optimisation, it is the safety property: `.md-prose > :first-child` is a direct-child rule, so quietly
     wrapping every chat bubble's prose in a run div would have shifted the spacing on every surface in the app.

     Mounting those parts is <MarkdownParts>, which is this component minus the parse. The split is for the one
     surface that has a part of its own to add (the file viewer's pretty-editing mode, which swaps the paragraph
     under the caret for a source editor): it builds its own part list and mounts it through the same shell,
     rather than growing a second prose surface that would drift from this one. -->
<script setup lang="ts">
import { computed } from "vue";
import { type MarkdownDecorator, renderMarkdownParts } from "../markdown/render.js";
import MarkdownParts from "./MarkdownParts.vue";

const { source, decorate } = defineProps<{
    // Markdown text. Treated as untrusted: the pipeline sanitizes before this is bound.
    source: string;
    // Optional pass over the sanitized DOM before it renders: the app uses it to linkify file mentions.
    decorate?: MarkdownDecorator;
}>();

// Prose runs and figures, in reading order (see renderMarkdownParts). Every run goes through the same engine
// with the same decorator, so file links and code blocks behave identically either side of a figure.
const parts = computed(() => renderMarkdownParts(source, decorate));
</script>

<template>
    <MarkdownParts :parts="parts" />
</template>
