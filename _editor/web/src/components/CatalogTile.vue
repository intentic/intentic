<script setup lang="ts">
import { BrandMark } from "@intentic/ui";

// One thing to pick from a catalog: a capability to connect (Capabilities), an extension to install (Sandbox ▸
// Extensions ▸ Browse). The whole tile is one button. The mark runs down its left edge as a band, for scanning a grid
// of many by logo. The name holds one line with whatever marks state it, and the description holds one more. Both
// truncate: a grid row is as tall as its tallest tile, so any line that grows costs every tile beside it.

const { idle = false } = defineProps<{
    name: string;
    /** Drawn before the name in a quieter tone: an extension's publisher, which is a trust fact rather than decoration. */
    prefix?: string | undefined;
    description?: string | undefined;
    logo?: string | undefined;
    icon?: string | undefined;
    art?: string | undefined;
    /** Present but unavailable (blocked, nothing to install): the mark and the name go quiet together. */
    idle?: boolean;
}>();
</script>

<template>
    <!-- Padding belongs to the text, not the tile, so the mark can reach the tile's edges; `overflow-hidden` clips it to the radius. -->
    <button
        type="button"
        class="flex h-full w-full items-stretch overflow-hidden rounded-lg bg-card text-left shadow-sm transition-colors hover:bg-overlay"
    >
        <BrandMark flush class="border-r border-line" :size="44" :name="name" :art="art" :logo="logo" :icon="icon" :idle="idle" />
        <span class="min-w-0 flex-1 px-2.5 py-2">
            <span class="flex items-center gap-x-1.5">
                <span class="truncate text-xs font-semibold" :class="idle ? `text-muted` : `text-content`"
                    ><span v-if="prefix" class="font-normal text-subtle">{{ prefix }}.</span>{{ name }}</span
                >
                <!-- State as glyphs, each carrying its sentence in a tooltip: connected, recommended, verified, an update. -->
                <slot name="marks" />
            </span>
            <span class="block truncate text-2xs text-muted"
                ><slot name="description">{{ description }}</slot></span
            >
        </span>
    </button>
</template>
