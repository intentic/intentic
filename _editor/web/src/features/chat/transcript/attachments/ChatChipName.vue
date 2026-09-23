<script setup lang="ts">
import { computed, ref, watch } from "vue";

/* An attachment's filename cut in the middle: what tells one attachment from the next is usually its ending, so the head truncates and the tail stays whole. */

const { name } = defineProps<{ name: string }>();

// Characters of the ending kept whole; a name too short for the split to matter stays one run.
const TAIL_CHARS = 9;
const split = computed(() => (name.length > TAIL_CHARS + 6 ? TAIL_CHARS : 0));
const head = computed(() => (split.value === 0 ? name : name.slice(0, -split.value)));
const tail = computed(() => (split.value === 0 ? `` : name.slice(-split.value)));

// Measured on the head's own box: `text-overflow: ellipsis` would leave the unused space between the mark and the ending.
const box = ref<HTMLElement>();
const clipped = ref(false);
watch(
    box,
    (element, _previous, onCleanup) => {
        clipped.value = false;
        if (element === undefined) {
            return;
        }
        const sync = (): void => {
            clipped.value = Math.round(element.scrollWidth) > Math.round(element.clientWidth);
        };
        const observer = new ResizeObserver(sync);
        observer.observe(element);
        sync();
        onCleanup(() => observer.disconnect());
    },
    { immediate: true, flush: `post` },
);
</script>

<template>
    <!-- Softened at the cut, so a half-drawn glyph reads as the name running into its mark. -->
    <span
        ref="box"
        class="overflow-hidden whitespace-nowrap"
        :class="clipped ? `[mask-image:linear-gradient(to_right,#000_calc(100%_-_0.6em),transparent)]` : ``"
        >{{ head }}</span
    >
    <span v-if="tail" class="shrink-0">{{ clipped ? `…` : `` }}{{ tail }}</span>
</template>
