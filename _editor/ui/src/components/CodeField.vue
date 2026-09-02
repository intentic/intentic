<!-- THE SOURCE SURFACE: a file's own text, coloured, and typed into.

     <Code> is the read-only block: a bordered card you drop a command into. <ProseField> is the writing field
     for SENTENCES. Neither is what a surface that shows somebody a markdown file and lets them correct it
     needs, so a view that wanted one reached for a bare <textarea>: mono, grey, a fixed number of rows:
     which meant the same file was coloured while it was being read and colourless the moment it was edited.
     This is one surface for both: `readonly` is the only difference between reading source and writing it.

     HOW IT IS COLOURED WHILE STILL BEING A TEXTAREA. Shiki's markup and a real caret cannot live in the same
     element, so the two are stacked in one grid cell: the highlighted <pre> underneath, and above it a
     textarea whose TEXT is transparent and whose caret and selection are not. What you see is the <pre>; what
     you type into is the textarea; they line up because both are handed the same box (`ui-code-field-box`:
     one CSS rule applied to both, for the same reason ProseField's typography is a variant rather than a class
     string the caller passes twice: a caller that can spell the two halves differently eventually will, and
     the failure here is text drifting off its own colours).

     IT SIZES TO ITS CONTENT, and the <pre> is what does it: being real, in-flow content, it makes the grid
     row as tall as the file and the textarea stretches to that. So a note is shown WHOLE and whatever frame it
     sits in decides when to scroll, instead of a `rows="8"` box showing eight lines of it. Nothing measures
     anything, so a webfont landing late or a container resizing cannot leave a stale height behind.

     IT ALWAYS WRAPS. A horizontal scrollbar on a writing surface hides the end of the line being written, and
     a wrapped <pre> beside an unwrapped textarea is two different line counts: i.e. the colours sliding off
     the text. Same reason ProseField refuses to be an <input>.

     UNCOLOURED IS A STATE, NOT A FAILURE: until the grammar chunk lands (and permanently for a language we
     ship no grammar for) the same text renders in a plain <pre> with the same box, so the file is readable and
     correctly sized from the first frame. -->
<script setup lang="ts">
import { computed, ref, useAttrs, watch } from "vue";
import type { ShikiLang } from "@intentic/code-read/langs";
import { useHighlighter } from "../composables/useHighlighter.js";

const {
    lang,
    readonly = false,
    placeholder = ``,
} = defineProps<{
    /** Shiki language id: typed against the grammars we ship, like <Code>'s. Omit to render as plain text. */
    lang?: ShikiLang;
    /** Reading rather than writing: the same rendering, with the caret off and the text locked. */
    readonly?: boolean;
    placeholder?: string;
}>();

const value = defineModel<string>({ required: true });

// The caller's `class` belongs on the WRAPPER (its margins, its minimum height, where it sits in a column);
// everything else it passes (listeners, aria, autofocus) belongs on the field itself. ProseField's split,
// and the reason the field is rendered even when it cannot be typed into: a readonly surface that quietly
// dropped its caller's `aria-label` and Escape handler would be a different component wearing the same name.
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const forwarded = computed(() => {
    const { class: _wrapper, ...rest } = attrs;
    return rest;
});

/* A trailing zero-width space on the COLOURED copy only. A <pre> gives a final newline no line box, so a file
 * ending in one would size the field a line short of the line the caret is actually on: ProseField's TAIL,
 * for the same reason. It is invisible, it is not in the model, and it never reaches disk. */
const TAIL = `​`;
// An empty field still has to be worth clicking on, so what gets measured is whatever is DISPLAYED: again
// ProseField's rule: mirroring only the value sizes a fresh field to nothing and hides its own instructions.
const empty = computed(() => value.value === ``);
const shown = computed(() => (empty.value ? placeholder : value.value) + TAIL);

const { highlight } = useHighlighter();
const html = ref<string | undefined>(undefined);

// v-html trusts Shiki's own output: it HTML-escapes the text, so the only markup is its <span style=…>
// colour tokens. Same contract as <Code>, including dropping a result that arrived after the input moved on.
let seq = 0;
watch(
    () => [shown.value, lang] as const,
    ([text, grammar]) => {
        const id = ++seq;
        if (grammar === undefined) {
            html.value = undefined;
            return;
        }
        void highlight(text, grammar).then((out) => {
            if (id === seq) {
                html.value = out;
            }
        });
    },
    { immediate: true },
);

// Exposed as the element rather than as a focus() wrapper, for the same reason ProseField exposes its own: a
// caller reaching for this is placing a caret, which is the element's own business.
const field = ref<HTMLTextAreaElement>();
defineExpose({ field });
</script>

<template>
    <div class="ui-code-field grid" :class="[attrs.class, { 'ui-code-field-placeholder': empty }]">
        <!-- The visible half. `[grid-area:1/1]` rather than absolute positioning: in flow it is what gives the
             row its height, which is the whole sizing story. -->
        <div v-if="html" class="ui-code-field-html [grid-area:1/1] min-w-0" v-html="html"></div>
        <pre v-else class="ui-code-field-box [grid-area:1/1] min-w-0">{{ shown }}</pre>
        <!-- The half that takes the keystrokes. Transparent text over its own colours; the caret and the
             selection are the only ink it contributes, and reading turns the caret off too.

             `field-bare` IS PART OF THE CONTRACT, not a tweak: this textarea has no frame of its own — it is a
             transparent sheet stacked over the coloured <pre>, and the border, the fill and the rounding all
             belong to whatever box the caller wrapped the pair in. Without it the skins treat it as an ordinary
             field and cut a recess into it (a dark inset strip across the top of the colours) and, on focus,
             draw a gold rim plus a 3px accent halo — square-cornered, inside the caller's rounded frame, around
             the whole scroll area. That is the highlight that appeared around the agent-fix composer the moment
             the caret landed in it. Same class and same reason as the chat composer's textarea. -->
        <textarea
            ref="field"
            v-bind="forwarded"
            v-model="value"
            spellcheck="false"
            :readonly="readonly"
            :class="[
                `field-bare ui-code-field-box ui-code-field-input [grid-area:1/1] min-w-0 resize-none overflow-hidden focus:outline-none`,
                readonly ? `caret-transparent` : ``,
            ]"
        ></textarea>
    </div>
</template>
