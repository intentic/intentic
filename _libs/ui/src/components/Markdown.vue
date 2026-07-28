<!-- Rendered markdown. The design system's ONE prose surface: sanitized HTML (see markdown/render.ts) styled
     by prose.css, with Shiki-coloured fenced blocks whose copy buttons are wired here.

     A component rather than a bare `v-html`, because every caller otherwise has to remember the same three
     things: sanitize before binding, carry the `md-prose` class, and delegate the code-block copy click (the
     blocks live inside v-html, so they can hold no component of their own). Extension views get it through
     the kit, so third-party UI renders agent prose exactly like the chat does.

     Type scale and measure come from prose.css's `--prose-*` tokens — set them on this element to tune a
     surface (`style="--prose-measure: 68ch"`); attributes fall through to the root. -->
<script setup lang="ts">
import { computed } from "vue";
import { copyCodeFromEvent } from "../markdown/code.js";
import { type MarkdownDecorator, renderMarkdown } from "../markdown/render.js";

const { source, decorate } = defineProps<{
    // Markdown text. Treated as untrusted: the pipeline sanitizes before this is bound.
    source: string;
    // Optional pass over the sanitized DOM before it renders — the app uses it to linkify file mentions.
    decorate?: MarkdownDecorator;
}>();

const html = computed(() => renderMarkdown(source, decorate));
</script>

<template>
    <div class="md-prose" @click="copyCodeFromEvent" v-html="html"></div>
</template>
