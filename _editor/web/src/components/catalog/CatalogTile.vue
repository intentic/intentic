<script setup lang="ts">
import { BrandMark } from "@intentic/ui";
import { useAttrs } from "vue";

// One thing in a catalog: a capability to connect (Capabilities), an extension to install or one already installed
// (Sandbox ▸ Extensions ▸ Browse and Installed). The mark runs down its left edge as a band, for scanning a grid of many
// by logo. The name holds one line with whatever marks state it, and the description holds one more. Both truncate: a
// grid row is as tall as its tallest tile, so any line that grows costs every tile beside it.
//
// The whole tile is one button, unless it holds a `#control` (an installed extension's switch): then the tile is the
// surface, the button stops where the control starts, and pressing the control never also presses the tile. Whatever
// the caller binds (its `@click`, an aria label) lands on the button either way; its class and style on the surface.

defineOptions({ inheritAttrs: false });

const { idle = false } = defineProps<{
    name: string;
    /** Drawn before the name in a quieter tone: an extension's publisher, which is a trust fact rather than decoration. */
    prefix?: string | undefined;
    description?: string | undefined;
    logo?: string | undefined;
    icon?: string | undefined;
    art?: string | undefined;
    /** Present but not doing anything (blocked, nothing to install, switched off): the mark and the name go quiet together. */
    idle?: boolean;
}>();

const attrs = useAttrs();
// Read at render, not cached: a caller's listeners and aria change between renders, and attrs are not reactive.
const pressAttrs = () => {
    const { class: _class, style: _style, ...press } = attrs;
    return press;
};
</script>

<template>
    <!-- Padding belongs to the text, not the tile, so the mark can reach the tile's edges; `overflow-hidden` clips it to the radius. -->
    <component
        :is="$slots[`control`] ? `div` : `button`"
        v-bind="$slots[`control`] ? {} : { type: `button`, ...pressAttrs() }"
        class="flex h-full w-full items-stretch overflow-hidden rounded-lg bg-card text-left shadow-sm transition-colors hover:bg-overlay"
        :class="$attrs.class"
        :style="$attrs.style"
    >
        <component
            :is="$slots[`control`] ? `button` : `span`"
            v-bind="$slots[`control`] ? { type: `button`, ...pressAttrs() } : {}"
            class="flex min-w-0 flex-1 items-stretch text-left"
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
        </component>
        <!-- Centred on the tile's height and clear of its edge by the text's own inset, so a switch sits where a row's would. -->
        <span v-if="$slots[`control`]" class="flex shrink-0 items-center pr-3 pl-1">
            <slot name="control" />
        </span>
    </component>
</template>
