<script setup lang="ts">
import { computed } from "vue";
import AssistantFace from "./AssistantFace.vue";
import { personaAccessory } from "./personaAccessory.js";
import { FACE_SIZES, type PersonaLike } from "./personaFace.js";

const { persona, size = FACE_SIZES.card } = defineProps<{ persona: PersonaLike; size?: number }>();

const accessory = computed(() => personaAccessory(persona));
</script>

<template>
    <!-- The id picks the color, so a rename keeps it; the name picks the prop, so a rename to Designer hands over a palette. -->
    <AssistantFace :seed="persona.id" :label="persona.label ?? persona.id" :accessory :size />
</template>
