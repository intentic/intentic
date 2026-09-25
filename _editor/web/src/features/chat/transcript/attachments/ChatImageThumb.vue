<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import PicturePeek from "./PicturePeek.vue";
import { type PeekBox, aspectOf, peekBox } from "./picturePeek";

// Compact image thumbnail with a floating preview on hover, shared by the composer's staged chips and the sent bubble.
// Where the preview goes is picturePeek's to decide, the same as for a finished turn's screenshots.

withDefaults(defineProps<{ src: string; alt: string; size?: string }>(), { size: `h-9 w-9` });

// Recomputed from the thumb's rect on each open.
const box = ref<PeekBox>();

const show = (event: MouseEvent): void => {
    const thumb = event.currentTarget as HTMLImageElement;
    box.value = peekBox(thumb, aspectOf(thumb));
};
const hide = (): void => {
    box.value = undefined;
};
onBeforeUnmount(hide);
</script>

<template>
    <img
        :src="src"
        :alt="alt"
        :class="size"
        class="shrink-0 cursor-zoom-in rounded-md border border-line object-cover"
        @mouseenter="show"
        @mouseleave="hide"
    />
    <PicturePeek :src="src" :alt="alt" :box="box" />
</template>
