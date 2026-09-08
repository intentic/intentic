<!--
    Loading placeholder for a document page, shared by DocTab and DocsView. Shaped like the page itself — title, paragraph, sections — rather than a
    centred spinner, since the real document starts at the top of the pane, not the middle.
-->
<script setup lang="ts">
/* Widths as a fixed uneven set walked in order: prose wraps unevenly and a placeholder that reshuffles on
 * every re-render is an animation nobody asked for. The last line of a paragraph is short because the last
 * line of a wrapped paragraph is. */
const PARAGRAPHS = [
    [`w-full`, `w-full`, `w-11/12`, `w-2/3`],
    [`w-full`, `w-5/6`, `w-1/2`],
    [`w-full`, `w-full`, `w-3/4`],
] as const;
</script>

<template>
    <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-6" role="status" aria-busy="true">
        <span class="sr-only">Reading the documentation…</span>
        <!-- The measure the renderer sets its prose to, so the outline wraps where the document will. -->
        <div class="mx-auto flex max-w-3xl flex-col gap-6" aria-hidden="true">
            <!-- The page title: one line at heading size, and shorter than the body it sits over. -->
            <span class="skeleton block h-6 w-2/5" />

            <div v-for="(paragraph, block) in PARAGRAPHS" :key="block" class="flex flex-col gap-3">
                <!-- Every section but the first opens with its own heading. -->
                <span v-if="block > 0" class="skeleton mt-2 block h-4 w-1/4" />
                <span v-for="(width, line) in paragraph" :key="line" class="skeleton block h-2.5" :class="width" />
            </div>
        </div>
    </div>
</template>
