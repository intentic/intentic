<script setup lang="ts">
import Icon from "@intentic/ui/icon";
import { areaIcon, type IconName } from "@intentic/ui/icons";
import { initialsOf } from "@intentic/ui";
import { computed } from "vue";

const { area, fallback, label } = defineProps<{ area: string; fallback?: IconName; label?: string }>();
const name = computed(() => areaIcon(area, fallback));
</script>

<template>
    <!-- Navigation owns the accessible name. Its drawing comes from the same pack as every other control. -->
    <Icon v-if="name !== undefined" :name="name" aria-hidden="true" />
    <span v-else class="text-sm font-semibold" aria-hidden="true">{{ initialsOf(label ?? area) }}</span>
</template>
