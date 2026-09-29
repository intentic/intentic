<script setup lang="ts">
import AssistantFace from "./AssistantFace.vue";
import { FACE_SIZES, type PersonaLike } from "./personaFace.js";

const { persona, size = FACE_SIZES.card } = defineProps<{ persona: PersonaLike; size?: number }>();
</script>

<template>
    <!-- Renaming a persona changes its label, while its familiar face stays with its id. -->
    <AssistantFace :seed="persona.id" :label="persona.label ?? persona.id" :size />
</template>
