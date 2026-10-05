<script setup lang="ts">
import { PROVIDER_BRAND_PATHS, providerFillRule } from "@intentic/constants";
import { Icon } from "@intentic/ui";
import { computed } from "vue";
import { providerMark } from "./privacyShield";

// A provider as the privacy pages draw it: its vendor's mark where it has one, else what it is (privacyShield.ts says
// which). `size` puts it in a tile that many pixels square, as a row's lead; without it the mark is a glyph in the text,
// sized and coloured by what surrounds it.

const { provider, local = false, size } = defineProps<{ provider: string; local?: boolean; size?: number }>();

const mark = computed(() => providerMark(provider, local));
</script>

<template>
    <span
        v-if="size !== undefined"
        class="grid shrink-0 place-items-center rounded-lg border border-line bg-content/5 text-content"
        :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.48)}px` }"
        aria-hidden="true"
    >
        <svg v-if="`brand` in mark" viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor">
            <path :d="PROVIDER_BRAND_PATHS[mark.brand]" :fill-rule="providerFillRule(mark.brand)" />
        </svg>
        <Icon v-else :name="mark.glyph" />
    </span>
    <svg v-else-if="`brand` in mark" viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" class="shrink-0" aria-hidden="true">
        <path :d="PROVIDER_BRAND_PATHS[mark.brand]" :fill-rule="providerFillRule(mark.brand)" />
    </svg>
    <Icon v-else :name="mark.glyph" class="shrink-0" aria-hidden="true" />
</template>
