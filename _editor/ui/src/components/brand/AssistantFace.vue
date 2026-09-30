<script setup lang="ts">
import { computed, useId } from "vue";
import { ASSISTANT_CANVAS, assistantFace, assistantLayers, assistantTint, type AssistantAccessory } from "./assistantFaces.js";
import { FACE_SIZES } from "./personaFace.js";

const {
    seed,
    label,
    size = FACE_SIZES.card,
    accessory = `terminal`,
    color,
    animated = true,
} = defineProps<{
    // Picks the body color and the motion phase, so one seed always looks and moves the same.
    seed: string;
    label: string;
    size?: number;
    accessory?: AssistantAccessory;
    // A `#rrggbb` that overrides the seed's body color.
    color?: string;
    animated?: boolean;
}>();

const identity = computed(() => assistantFace(seed));
const tint = computed(() => assistantTint(color ?? identity.value.color.hex));
const layers = computed(() => assistantLayers(accessory));
// Every face defines its own filter; ids are page-wide, and two faces in one list rarely share a color.
const tintId = `assistant-tint-${useId()}`;
</script>

<template>
    <span
        class="assistant-face inline-flex shrink-0 items-center justify-center"
        :data-animated="animated && size >= FACE_SIZES.row"
        :style="{
            width: `${size}px`,
            height: `${size}px`,
            '--assistant-duration': `${identity.duration}s`,
            '--assistant-delay': `${identity.delay}s`,
        }"
        role="img"
        :aria-label="label"
    >
        <svg
            class="assistant-art block h-full w-full select-none overflow-visible"
            :viewBox="`0 0 ${ASSISTANT_CANVAS} ${ASSISTANT_CANVAS}`"
            aria-hidden="true"
            focusable="false"
        >
            <defs>
                <!-- Grey clay to the body color: desaturate, then map dark, mid, light and highlight per channel. -->
                <filter :id="tintId" color-interpolation-filters="sRGB">
                    <feColorMatrix type="saturate" values="0" />
                    <feComponentTransfer>
                        <feFuncR type="table" :tableValues="tint.r" />
                        <feFuncG type="table" :tableValues="tint.g" />
                        <feFuncB type="table" :tableValues="tint.b" />
                    </feComponentTransfer>
                </filter>
            </defs>
            <image
                v-for="(layer, index) in layers"
                :key="index"
                :href="layer.src"
                :x="layer.rect[0]"
                :y="layer.rect[1]"
                :width="layer.rect[2]"
                :height="layer.rect[3]"
                :filter="layer.tint ? `url(#${tintId})` : undefined"
            />
        </svg>
    </span>
</template>

<style scoped>
/* A tiny rise and breath keep the illustration alive without moving its allocated space. */
.assistant-face[data-animated="true"] .assistant-art {
    transform-origin: 50% 85%;
    animation: assistant-breathe var(--assistant-duration) ease-in-out var(--assistant-delay) infinite;
}

@keyframes assistant-breathe {
    0%, 100% { transform: translateY(0) rotate(-.6deg) scale(1); }
    50% { transform: translateY(-2%) rotate(.6deg) scale(1.015, 1.025); }
}

@media (prefers-reduced-motion: reduce) {
    .assistant-face[data-animated="true"] .assistant-art {
        animation: none;
    }
}
</style>
