<!-- THE PROSE SHELL: a rendered document's parts, mounted. One `.md-prose` element, whatever the document is
     made of, and the only place in the design system that turns the engine's part list into DOM.

     Split out of <Markdown> so a surface that needs to put something of ITS OWN into the reading flow can do
     that without a second prose shell. The file viewer's pretty-editing surface is the one that does: it swaps
     the paragraph under the caret for a source editor and leaves the rest of the document rendered, which is
     one part in the middle of a list of parts and nothing else. Rebuilt in the app, it would have had to
     re-implement the three things this file exists to remember (sanitized bind, `md-prose`, the delegated
     code-block copy) and would have drifted from them the first time one changed.

     <Markdown> is now this component plus the parse, and is still what every other surface uses. -->
<script lang="ts">
import type { MarkdownPart } from "../markdown/render.js";

/* A part the CALLER draws, spliced into the reading flow. The engine never produces one, it has no idea what
   would go in it; a surface that wants one builds its own part list and fills the `slot` slot.

   There is at most one useful per document in practice (an editor follows a single caret), but nothing here
   assumes that: `key` distinguishes them for Vue when a surface splices several. */
export type ProseSlotPart = { readonly kind: "slot"; readonly key?: string };
export type ProsePart = MarkdownPart | ProseSlotPart;
</script>

<script setup lang="ts">
import { computed } from "vue";
import { copyCodeFromEvent } from "../markdown/code.js";
import MarkdownFigure from "./MarkdownFigure.vue";

defineOptions({ inheritAttrs: false });

const { parts } = defineProps<{ parts: readonly ProsePart[] }>();

/* The whole document as one string when it holds nothing but prose: the shape every existing surface renders
   in, and the reason a document without figures produces byte-identical DOM to the one v-html it always was.
   See <Markdown> for why that is a safety property and not an optimisation. */
const plain = computed(() => {
    const only = parts.length === 1 ? parts[0] : undefined;
    return only?.kind === `html` ? only.html : undefined;
});
</script>

<template>
    <div v-if="plain !== undefined" v-bind="$attrs" class="md-prose" @click="copyCodeFromEvent" @pointerdown="copyCodeFromEvent" v-html="plain"></div>
    <div v-else v-bind="$attrs" class="md-prose" @click="copyCodeFromEvent" @pointerdown="copyCodeFromEvent">
        <template v-for="(part, index) in parts" :key="part.kind === `slot` ? `slot:${part.key ?? ``}` : index">
            <div v-if="part.kind === `html`" class="md-run" v-html="part.html"></div>
            <MarkdownFigure v-else-if="part.kind === `figure`" :figure="part.figure" />
            <slot v-else name="slot"></slot>
        </template>
    </div>
</template>
