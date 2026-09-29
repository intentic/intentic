<script setup lang="ts">
import { computed } from "vue";
import { assistantFace, ASSISTANT_CHARACTERS, type AssistantCharacter } from "./assistantFaces.js";
import { FACE_SIZES } from "./personaFace.js";

const { seed, label, size = FACE_SIZES.card, character, animated = true } = defineProps<{
    seed: string;
    label: string;
    size?: number;
    character?: AssistantCharacter;
    animated?: boolean;
}>();

const identity = computed(() => assistantFace(seed));
const companion = computed(() => ASSISTANT_CHARACTERS[character ?? identity.value.character]);
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
        <img
            class="assistant-art block h-full w-full select-none object-contain"
            :src="companion.src"
            :width="size"
            :height="size"
            alt=""
            aria-hidden="true"
            draggable="false"
            decoding="async"
        />
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
