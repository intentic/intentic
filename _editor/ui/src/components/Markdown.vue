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
     Attribute fallthrough is explicit (`inheritAttrs: false` + `v-bind="$attrs"`) because the two shapes are two
     template roots, and the documented `style="--prose-*"` contract has to hold for both.

     THIS IS THE READING SURFACE, and there is a separate writing one. The workspace file viewer's edit mode
     builds its own DOM from the document's source, so that the text it holds IS the file and a caret in it is a
     position in that file (viewers/markdownSourceDom.ts). The two agree because they are styled by the same
     prose.css and emit the same tags; nothing here needs to know about it. -->
<script setup lang="ts">
import { computed } from "vue";
import { copyCodeFromEvent } from "../markdown/code.js";
import { type MarkdownDecorator, renderMarkdownParts } from "../markdown/render.js";
import MarkdownFigure from "./MarkdownFigure.vue";

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
