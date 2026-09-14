<script setup lang="ts">
import Icon from "@intentic/ui/icon";
import { areaIcon, type IconName } from "@intentic/ui/icons";
import { initialsOf } from "@intentic/ui";
import { computed } from "vue";

const { area, fallback, label, monogram } = defineProps<{ area: string; fallback?: IconName; label?: string; monogram?: string }>();
const name = computed(() => areaIcon(area, fallback));
// Cut to two: the tile is a square of glyph, and three letters read as a word rather than a mark.
const letters = computed(() => (monogram === undefined || monogram === `` ? undefined : monogram.slice(0, 2).toUpperCase()));
</script>

<template>
    <!-- Navigation owns the accessible name. Its drawing comes from the same pack as every other control. -->
    <!-- A monogram wins over the glyph: it says WHICH thing the tile stands for, which no icon name can. -->
    <span v-if="letters !== undefined" class="text-sm font-semibold" aria-hidden="true">{{ letters }}</span>
    <Icon v-else-if="name !== undefined" :name="name" aria-hidden="true" />
    <span v-else class="text-sm font-semibold" aria-hidden="true">{{ initialsOf(label ?? area) }}</span>
</template>
