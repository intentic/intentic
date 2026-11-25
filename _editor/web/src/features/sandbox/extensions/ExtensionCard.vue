<script setup lang="ts">
import { BrandMark } from "@intentic/ui";

// An extension the Installed list holds but has no page to open for: one written in this workspace and waiting for its
// yes, one whose folder doesn't read as an extension, one running here that the sandbox doesn't list. Drawn in the
// tiles' own look (<CatalogTile>: the mark down the left edge, the name, one line under it) but as wide as the list,
// because what it carries is something to read whole (what a yes allows, why it won't load) rather than a fact to scan.
// That goes in the default slot, under the head and lined up with the name, where it may wrap.

defineProps<{
    name: string;
    /** Drawn before the name in a quieter tone, as the tiles draw a publisher. */
    prefix?: string | undefined;
    /** The head's second line: where it lives, or the state it is in. */
    line?: string | undefined;
    art?: string | undefined;
    logo?: string | undefined;
    icon?: string | undefined;
}>();
</script>

<template>
    <div class="overflow-hidden rounded-lg bg-card shadow-sm">
        <!-- The head is a tile's height, so the mark's band is a tile's size however long the body runs. Its band is square
             to the head's height, which only a definite height gives it: a grid cell's stretch is one (as a tile's grid row
             is), where a flex row sized by its text is not, and the band would shrink to its glyph. One `minmax(0, 1fr)`
             column, not an auto one, or a long path would widen the head past the card and push its control off. -->
        <div class="grid grid-cols-1">
            <div class="flex h-full items-stretch">
                <BrandMark flush class="border-r border-line" :size="44" :name="name" :art="art" :logo="logo" :icon="icon" />
                <div class="min-w-0 flex-1 px-2.5 py-2">
                    <span class="block truncate text-xs font-semibold text-content"
                        ><span v-if="prefix" class="font-normal text-subtle">{{ prefix }}.</span>{{ name }}</span
                    >
                    <span v-tooltip.overflow="line" class="block truncate text-2xs text-muted"
                        ><slot name="line">{{ line }}</slot></span
                    >
                </div>
                <div v-if="$slots[`control`]" class="flex shrink-0 items-center pr-3 pl-1">
                    <slot name="control" />
                </div>
            </div>
        </div>
        <!-- Starts where the name does (the band's width plus the text's inset), so it reads as the head's own. -->
        <div v-if="$slots[`default`]" class="flex flex-col gap-1 border-t border-line-subtle py-2.5 pr-3 pl-14 text-2xs">
            <slot />
        </div>
    </div>
</template>
