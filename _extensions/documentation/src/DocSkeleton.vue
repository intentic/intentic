<!-- A DOCUMENT THAT HAS NOT ARRIVED YET, for the two surfaces that render one: the workspace tab beside the
     code (DocTab) and the routed area (DocsView).

     Both used to show a centred spinner, which is the wrong instrument for this wait twice over. A spinner is
     the same size whether it stands in for a line or for a page, so it says nothing about what is coming; and
     it sits in the MIDDLE of the pane while the document it stands for starts at the top, so the eye is sent
     to one place and the prose then lands somewhere else. A page-shaped outline is the same information in the
     shape the answer takes — a title, a paragraph under it, and the sections after that.

     Shared rather than written twice because the two callers render the same document through the same
     renderer, and two copies of one outline is two things to keep in step with one thing. -->
<script setup lang="ts">
/* Widths as a fixed uneven set walked in order — prose wraps unevenly and a placeholder that reshuffles on
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
