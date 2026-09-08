<!--
    The writing field for prose read in sentences, as opposed to `ui.input()`'s form fields: borderless until focused, always a textarea so long
    lines wrap. Sizes to content via an invisible replica sharing the field's own typography variant.
-->
<script setup lang="ts">
import { computed, ref, useAttrs } from "vue";

const { variant = `prose` } = defineProps<{
    /** `heading` writes the `# Heading`; `prose` is everything else; `post` is the compact tier shown elsewhere too. */
    variant?: `heading` | `prose` | `post`;
    placeholder?: string;
}>();

const value = defineModel<string>({ required: true });

// Caller's `class` goes on the wrapper; listeners, aria and autofocus forward to the field itself.
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const forwarded = computed(() => {
    const { class: _wrapper, ...rest } = attrs;
    return rest;
});

// A trailing zero-width space, so a value ending in a newline still reserves the line the caret is actually on.
const TAIL = `​`;

// Two tiers, both at or above prose.css's floor (0.875rem, ~1.7 leading), a writing surface's minimum.
// `max-md:text-base` raises the floor on mobile: iOS Safari zooms a page when a field under 16px takes focus.
const BOX = {
    heading: `[grid-area:1/1] whitespace-pre-wrap break-words px-2 py-0.5 text-lg font-semibold leading-snug tracking-tight`,
    prose: `[grid-area:1/1] whitespace-pre-wrap break-words px-2 py-1 text-sm leading-[1.7] max-md:text-base`,
    post: `[grid-area:1/1] whitespace-pre-wrap break-words px-2 py-1 text-sm leading-[1.7] max-md:text-base`,
};

// Exposes the element, not a focus() wrapper: callers reaching for this are placing a caret.
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
                `field-bare ui-field-lit resize-none overflow-hidden rounded-md`,
                variant === `heading` ? `placeholder:font-normal` : ``,
            ]"
        />
    </div>
</template>
