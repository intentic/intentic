<!--
    A textarea that stays syntax-highlighted while being edited: a Shiki-highlighted `<pre>` stacked under a transparent-text textarea sharing one
    box. `readonly` is the only difference between reading and writing. Sizes to content and always wraps.
-->
<script setup lang="ts">
import { computed, ref, useAttrs, watch } from "vue";
import type { ShikiLang } from "@intentic/code-read/langs";
import { useHighlighter } from "../../composables/useHighlighter.js";

const {
    lang,
    readonly = false,
    placeholder = ``,
} = defineProps<{
    /** Shiki language id from the grammars we ship; omit to render as plain text. */
    lang?: ShikiLang;
    /** Reading rather than writing: the same rendering, with the caret off and the text locked. */
    readonly?: boolean;
    placeholder?: string;
}>();

const value = defineModel<string>({ required: true });

// Caller's `class` goes on the wrapper; listeners, aria and autofocus forward to the field, even when readonly.
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const forwarded = computed(() => {
    const { class: _wrapper, ...rest } = attrs;
    return rest;
});

// Zero-width space on the displayed copy only: a <pre> collapses a trailing newline, undersizing the field.
const TAIL = `​`;
// Sized off what's displayed, not the raw value, so an empty field still shows (and sizes for) its placeholder.
const empty = computed(() => value.value === ``);
const shown = computed(() => (empty.value ? placeholder : value.value) + TAIL);

const { highlight } = useHighlighter();
const html = ref<string | undefined>(undefined);

// v-html trusts Shiki's escaped output (only `<span style>` tokens); a stale result is dropped if outdated.
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

// Exposes the element itself, not a focus() wrapper: a caller reaching for it is placing a caret.
const field = ref<HTMLTextAreaElement>();
defineExpose({ field });
</script>

<template>
    <div class="ui-code-field grid" :class="[attrs.class, { 'ui-code-field-placeholder': empty }]">
        <!-- `[grid-area:1/1]`, not absolute: staying in flow is what gives the row its height. -->
        <div v-if="html" class="ui-code-field-html [grid-area:1/1] min-w-0" v-html="html"></div>
        <pre v-else class="ui-code-field-box [grid-area:1/1] min-w-0">{{ shown }}</pre>
        <!--
            Takes the keystrokes; transparent text over the colored `<pre>`, contributing only caret and selection.
            `field-bare` is required, or skins draw their own inset and focus ring meant for a standalone field.
        -->
        <textarea
            ref="field"
            v-bind="forwarded"
            v-model="value"
            spellcheck="false"
            :readonly="readonly"
            :class="[
                `field-bare ui-code-field-box ui-code-field-input [grid-area:1/1] min-w-0 resize-none overflow-hidden`,
                readonly ? `caret-transparent` : ``,
            ]"
        ></textarea>
    </div>
</template>
