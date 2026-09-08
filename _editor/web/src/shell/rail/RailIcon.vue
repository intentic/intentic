<script setup lang="ts">
import Icon from "@intentic/ui/icon";
import { isIconName, type IconName } from "@intentic/ui/icons";
import { initialsOf } from "@intentic/ui";
import { computed } from "vue";
import { RAIL_GLYPHS } from "./railGlyphs";

const { area, fallback, label } = defineProps<{ area: string; fallback?: IconName; label?: string }>();
const glyph = computed(() => (Object.hasOwn(RAIL_GLYPHS, area) ? RAIL_GLYPHS[area] : undefined));
</script>

<template>
    <!-- Navigation owns the accessible name; its glyph is always decoration. No Iconify optical scaling:
         these drawings already fill the intended box, including at the smallest rail preference. -->
    <svg v-if="glyph" class="rail-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path v-if="glyph.outline" :d="glyph.outline" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter" />
        <path v-if="glyph.solid" :d="glyph.solid" fill="currentColor" />
    </svg>
    <Icon v-else-if="fallback !== undefined && isIconName(fallback)" :name="fallback" aria-hidden="true" />
    <span v-else class="text-sm font-semibold" aria-hidden="true">{{ initialsOf(label ?? area) }}</span>
</template>

<style scoped>
.rail-icon {
    display: inline-block;
    width: 1em;
    height: 1em;
    flex: none;
    vertical-align: -0.125em;
}
</style>
