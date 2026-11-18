<script setup lang="ts">
import { computed } from "vue";
import AssistantFace from "./AssistantFace.vue";
import { roleAccessory } from "./roleAccessory.js";
import { FACE_SIZES, type RoleLike } from "./roleFace.js";

const { role, size = FACE_SIZES.card } = defineProps<{ role: RoleLike; size?: number }>();

const accessory = computed(() => roleAccessory(role));
</script>

<template>
    <!-- The id picks the color, so a rename keeps it; the name picks the prop, so a rename to Designer hands over a palette. -->
    <AssistantFace :seed="role.id" :label="role.label ?? role.id" :accessory :size />
</template>
