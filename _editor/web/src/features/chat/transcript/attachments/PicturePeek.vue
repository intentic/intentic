<script setup lang="ts">
import type { PeekBox } from "./picturePeek";

// The bigger version of a hovered picture, drawn in the region peekBox chose. Teleports out of the chat scroller's
// clipping, and never takes the pointer, so it can't eat the hover that summons it.

defineProps<{ src: string | undefined; alt: string; box: PeekBox | undefined }>();

const FLEX = { start: `flex-start`, center: `center`, end: `flex-end` } as const;
</script>

<template>
    <Teleport to="body">
        <div
            v-if="box && src"
            class="pointer-events-none fixed z-50 flex"
            :style="{
                left: `${box.left}px`,
                right: `${box.right}px`,
                top: `${box.top}px`,
                bottom: `${box.bottom}px`,
                justifyContent: FLEX[box.justify],
                alignItems: FLEX[box.align],
            }"
        >
            <img :src="src" :alt="alt" class="max-h-full min-h-0 max-w-full min-w-0 rounded-lg border border-line-strong bg-card object-contain shadow-2xl" />
        </div>
    </Teleport>
</template>
