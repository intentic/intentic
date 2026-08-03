<!-- THE WRITING FIELD — what you type a paragraph into, as opposed to what you fill a form in with.

     `cmp.input()` is the form field: a bordered box of a fixed height, right for a name, a number, a shell
     command. This is its counterpart for text that is READ IN SENTENCES — a story's narrative, a step's
     instructions, an acceptance criterion. Three stacked bordered boxes on a panel is a form; the same three
     without the boxes is a document, and a document is what someone writing prose is actually looking at. So
     there is no border and no fill until the caret is in it: an editor shows you your text, and shows chrome
     only for the line you are on.

     IT IS A TEXTAREA EVEN FOR ONE-LINERS. An <input> scrolls a long sentence sideways inside its box, hiding
     the end of it behind an edge and defeating the measure the column was given. Wrapping is what makes prose
     readable, so nothing here is an input.

     IT SIZES TO ITS CONTENT WITHOUT JAVASCRIPT. The field shares a grid cell with an invisible replica of its
     own text, and the cell is as tall as the taller of the two — so the box tracks the words through anything
     that reflows them. That is not a preference over measure-and-set on `nextTick`: measuring on nextTick
     measures the FALLBACK font, and the webfont swap that lands a frame later reflows the prose taller inside a
     box already fixed at the old height, clipping the last paragraphs of every long document (seen in a
     browser, which is the only way that class of bug is ever seen). A container resize does the same. There is
     nothing to keep up to date if the browser does the sizing.

     THE REPLICA HAS TO AGREE WITH THE FIELD TO THE PIXEL — same font, size, leading, padding, wrapping — which
     is why the typography is a VARIANT here rather than a class string the caller passes to both. A caller that
     can spell the two halves differently eventually will, and the failure is a box that is silently one line
     short. It mirrors whatever the field is DISPLAYING, which for an empty one is its placeholder: mirroring
     only the value sizes a fresh field to nothing and cuts its own instructions off mid-sentence. -->
<script setup lang="ts">
import { computed, ref, useAttrs } from "vue";

const { variant = `prose` } = defineProps<{
    /** `heading` is the document's own title — the `# Heading` the field writes. `prose` is everything else. */
    variant?: `heading` | `prose`;
    placeholder?: string;
}>();

const value = defineModel<string>({ required: true });

// The caller's `class` belongs on the WRAPPER (its margins, its minimum height, where it sits in a column);
// everything else it passes — listeners, aria, autofocus — belongs on the field itself.
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const forwarded = computed(() => {
    const { class: _wrapper, ...rest } = attrs;
    return rest;
});

// A trailing zero-width space, so a value ending in a newline still reserves the line the caret is actually on.
const TAIL = `​`;

/* The two tiers, and the pair of them is the whole type scale a written document needs. Both sit at or above
 * prose.css's floor (0.875rem read in paragraphs, ~1.7 leading) — a writing surface set below the floor is the
 * mistake this component exists to make unrepeatable. */
const BOX = {
    heading: `[grid-area:1/1] whitespace-pre-wrap break-words px-2 py-0.5 text-lg font-semibold leading-snug tracking-tight`,
    prose: `[grid-area:1/1] whitespace-pre-wrap break-words px-2 py-1 text-sm leading-[1.7]`,
};

// Exposed as the element rather than as a focus() wrapper: callers that reach for this are placing a CARET
// (`setSelectionRange` to the end when a list opens the next row), which is the element's own business.
const field = ref<HTMLTextAreaElement>();
defineExpose({ field });
</script>

<template>
    <div class="grid" :class="attrs.class">
        <!-- The invisible half. `visibility: hidden` still occupies its cell, which is the whole point. -->
        <div :class="[BOX[variant], `pointer-events-none invisible`]">{{ value || placeholder }}{{ TAIL }}</div>
        <textarea
            ref="field"
            v-bind="forwarded"
            v-model="value"
            rows="1"
            :placeholder="placeholder"
            :class="[
                BOX[variant],
                `resize-none overflow-hidden rounded-md bg-transparent text-content placeholder:text-subtle focus:bg-overlay focus:outline-none`,
                variant === `heading` ? `placeholder:font-normal` : ``,
            ]"
        />
    </div>
</template>
