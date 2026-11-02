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

// A logo made by the editor's Stylize logo (marked data-intentic-logo) used to paint a tinted square behind its glyph.
// The square is gone from new logos; saved ones still carry it, so it's dropped here. Uploaded images pass untouched.
const STYLED_PREFIX = `data:image/svg+xml,`;
const STYLED_BACKING = /<rect width="64" height="64" rx="14" fill="#[0-9a-f]{6}" fill-opacity="\.14"\/>/i;
const src = computed(() => {
    if (!image?.startsWith(STYLED_PREFIX)) {
        return image;
    }
    let svg: string;
    try {
        svg = decodeURIComponent(image.slice(STYLED_PREFIX.length));
    } catch {
        return image;
    }
    return svg.includes(`data-intentic-logo=`) && STYLED_BACKING.test(svg)
        ? `${STYLED_PREFIX}${encodeURIComponent(svg.replace(STYLED_BACKING, ``))}`
        : image;
});

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
        <img v-if="src" :src="src" alt="" class="h-full w-full object-contain" draggable="false" />
        <span v-else-if="letter !== undefined" class="font-semibold uppercase leading-none text-content">{{ letter }}</span>
        <Icon v-else name="server" :style="{ fontSize: size === undefined ? `1.125rem` : `${size * 0.55}px` }" />
    </span>
</template>
