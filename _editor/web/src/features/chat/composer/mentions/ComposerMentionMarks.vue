<script setup lang="ts">
import { mentionRanges } from "@intentic/sandbox-contract/text/mentions";
import { computed, onBeforeUnmount, ref, watch } from "vue";

/* The `@path` mentions in the draft, marked where they stand: a mirror of the textarea's text drawn behind it, transparent but for a pill behind each mention that rides as a file. The words stay the textarea's own, so caret, selection and editing are untouched; the mirror only has to wrap the same, which it does by copying the textarea's own box (padding, type, leading, and the width a scrollbar leaves). What it marks is mentionRanges, the very tokens the send reads, so a marked word is one the agent gets and an unmarked `@word` is plain text. */

const { text, input } = defineProps<{
    text: string;
    // The textarea it sits behind, whose scroll it follows.
    input: HTMLTextAreaElement | null;
}>();

const parts = computed(() => {
    const out: { text: string; mention: boolean }[] = [];
    let at = 0;
    for (const range of mentionRanges(text)) {
        out.push({ text: text.slice(at, range.start), mention: false }, { text: text.slice(range.start, range.end), mention: true });
        at = range.end;
    }
    // A trailing newline collapses in a div where a textarea keeps the empty line, so a space holds it open.
    out.push({ text: `${text.slice(at)} `, mention: false });
    return out;
});

// Drawn only while something is marked: a draft with no mention needs no mirror.
const marked = computed(() => parts.value.some((part) => part.mention));
const mirror = ref<HTMLElement | null>(null);
// The textarea's box as drawn, read off it rather than restated, so the mirror's lines break where the textarea's do:
// a scrollbar narrows it once a long draft scrolls, and the chip row above changes its top padding.
const box = ref<Record<string, string>>({});
const BOX = [`paddingTop`, `paddingRight`, `paddingBottom`, `paddingLeft`, `fontFamily`, `fontSize`, `lineHeight`, `letterSpacing`] as const;
const follow = (): void => {
    if (mirror.value === null || input === null) {
        return;
    }
    const drawn = getComputedStyle(input);
    box.value = { width: `${input.clientWidth}px`, ...Object.fromEntries(BOX.map((key) => [key, drawn[key]])) };
    mirror.value.scrollTop = input.scrollTop;
};
const resized = new ResizeObserver(follow);
watch(
    () => input,
    (now, was) => {
        was?.removeEventListener(`scroll`, follow);
        if (was) {
            resized.unobserve(was);
        }
        now?.addEventListener(`scroll`, follow, { passive: true });
        if (now) {
            resized.observe(now, { box: `border-box` });
        }
    },
    { immediate: true },
);
watch(() => text, follow, { flush: `post` });
onBeforeUnmount(() => {
    input?.removeEventListener(`scroll`, follow);
    resized.disconnect();
});
</script>

<template>
    <div
        v-if="marked"
        ref="mirror"
        aria-hidden="true"
        :style="box"
        class="pointer-events-none absolute inset-y-0 left-0 overflow-hidden break-words whitespace-pre-wrap text-transparent select-none"
    >
        <template v-for="(part, index) in parts" :key="index">
            <mark v-if="part.mention" class="rounded-sm bg-primary-600/15 text-transparent ring-1 ring-primary-600/30 box-decoration-clone">{{
                part.text
            }}</mark>
            <template v-else>{{ part.text }}</template>
        </template>
    </div>
</template>
