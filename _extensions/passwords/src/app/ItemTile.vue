<!-- The square a password leads with: a site's first letter on its own colour, or a glyph for an app, a terminal, a phone. -->
<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";
import { computed } from "vue";
import type { PasswordItem } from "./port.js";
import { tileOf } from "./words.js";

const { item, size = `md` } = defineProps<{ item: PasswordItem; size?: `md` | `lg` }>();

const tile = computed(() => tileOf(item));
// The series colours read in both looks; the tint under the letter is the same colour, faint, so the tile is never a
// loud block in a calm list.
const style = computed(() =>
    tile.value.kind === `letter`
        ? { color: `var(--color-series-${String(tile.value.hue)})`, background: `color-mix(in oklab, var(--color-series-${String(tile.value.hue)}) 16%, transparent)` }
        : undefined,
);
</script>

<template>
    <span
        class="flex shrink-0 items-center justify-center rounded-lg font-semibold"
        :class="[size === `lg` ? `size-11 text-lg` : `size-8 text-sm`, tile.kind === `glyph` ? `bg-overlay text-muted` : ``]"
        :style="style"
        aria-hidden="true"
    >
        <template v-if="tile.kind === `letter`">{{ tile.letter }}</template>
        <span v-else-if="tile.glyph === `terminal`" class="font-mono text-xs">&gt;_</span>
        <Icon v-else :name="tile.glyph" />
    </span>
</template>
