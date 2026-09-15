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
    <!-- Letters are a FRACTION of the glyph the tile would otherwise draw, not a type step of their own: at a
         fixed `text-sm` a monogram tile was two thirds the weight of its neighbours on every surface at once.
         0.8em lands the cap height just under the icon's, which is where two letters stop shouting. -->
    <span v-if="letters !== undefined" class="text-[0.8em] font-semibold tracking-tight" aria-hidden="true">{{ letters }}</span>
    <Icon v-else-if="name !== undefined" :name="name" aria-hidden="true" />
    <span v-else class="text-[0.8em] font-semibold tracking-tight" aria-hidden="true">{{ initialsOf(label ?? area) }}</span>
</template>
