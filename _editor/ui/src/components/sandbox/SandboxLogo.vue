<!-- The sandbox's own picture or monogram: no plate, no border, so it reads quietly on whatever sits behind it. -->
<script setup lang="ts">
import { computed } from "vue";
import Icon from "../primitives/Icon.vue";

const { size, image, name } = defineProps<{
    /** Pixels; omit to stretch to the container's box (rail tile, list row). */
    size?: number;
    image?: string | null;
    name?: string;
}>();

const letter = computed(() => {
    const initial = (name ?? ``).trim().charAt(0);
    return initial === `` ? undefined : initial.toUpperCase();
});

const box = computed(() =>
    size === undefined
        ? { width: `100%`, height: `100%`, fontSize: undefined as string | undefined }
        : {
              width: `${size}px`,
              height: `${size}px`,
              fontSize: `${Math.max(10, size * 0.45)}px`,
          },
);
</script>

<template>
    <span
        class="relative inline-flex shrink-0 items-center justify-center overflow-hidden text-muted"
        :style="{ width: box.width, height: box.height, ...(box.fontSize === undefined ? {} : { fontSize: box.fontSize }) }"
        aria-hidden="true"
    >
        <img v-if="image" :src="image" alt="" class="h-full w-full object-cover" draggable="false" />
        <span v-else-if="letter !== undefined" class="font-semibold uppercase leading-none text-content">{{ letter }}</span>
        <Icon v-else name="server" :style="{ fontSize: size === undefined ? `1.125rem` : `${size * 0.55}px` }" />
    </span>
</template>
