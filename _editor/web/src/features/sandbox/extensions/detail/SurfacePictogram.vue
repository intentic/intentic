<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import { computed } from "vue";

// Where in the editor a contribution lands, drawn as a thumbnail of the editor with that spot lit: a tile on the rail,
// a tab in the sandbox's strip, a card among the capabilities. What has no place on screen (an agent plugin, a
// background service, an image layer) draws its glyph in the same frame, so a list of them still lines up.

const { place } = defineProps<{
    /** A view's surface (`rail`, `sandbox`, `directory`) or a contribution kind (`capabilities`, `viewers`, …). */
    place: string;
}>();

const SCREENS = new Set([`rail`, `sandbox`, `directory`, `sideViews`, `capabilities`, `automationTemplates`, `viewers`, `documents`, `commands`]);

const GLYPHS = new Map<string, IconName>([
    [`listener`, `bolt`],
    [`processes`, `server`],
    [`agent`, `robot`],
    [`bin`, `terminal`],
    [`environment`, `box`],
    [`tools`, `wrench`],
    [`files`, `file`],
]);

const screen = computed(() => SCREENS.has(place));
const glyph = computed<IconName>(() => GLYPHS.get(place) ?? `extensions`);
</script>

<template>
    <span class="relative flex h-7 w-10 shrink-0 overflow-hidden rounded-md border border-line-strong bg-content/5" aria-hidden="true">
        <template v-if="screen">
            <!-- A tile on the rail down the left edge. -->
            <span v-if="place === `rail`" class="flex w-3 flex-col items-center gap-0.5 border-r border-line-strong pt-1.5">
                <span class="size-1.5 rounded-2xs bg-content/25" />
                <span class="size-1.5 rounded-2xs bg-primary-500" />
                <span class="size-1.5 rounded-2xs bg-content/25" />
            </span>
            <!-- A tab in the strip along the top. -->
            <span v-else-if="place === `sandbox`" class="flex h-2.5 w-full gap-0.5 border-b border-line-strong px-1 pt-1">
                <span class="w-2 rounded-t-2xs bg-content/25" />
                <span class="w-2 rounded-t-2xs bg-primary-500" />
                <span class="w-2 rounded-t-2xs bg-content/25" />
            </span>
            <!-- A panel beside the files. -->
            <span v-else-if="place === `directory`" class="m-1 w-3 rounded-2xs bg-primary-500/70" />
            <!-- The side panel beside the chat. -->
            <span v-else-if="place === `sideViews`" class="m-1 ml-auto w-3 rounded-2xs bg-primary-500/70" />
            <!-- One card among the capabilities. -->
            <span v-else-if="place === `capabilities`" class="grid w-full grid-cols-2 gap-0.5 p-1">
                <span class="rounded-2xs bg-content/25" />
                <span class="rounded-2xs bg-primary-500" />
                <span class="rounded-2xs bg-content/25" />
                <span class="rounded-2xs bg-content/25" />
            </span>
            <!-- Entries in a list of automations. -->
            <span v-else-if="place === `automationTemplates`" class="flex w-full flex-col gap-0.5 p-1.5">
                <span class="h-1 w-4/5 rounded-full bg-primary-500" />
                <span class="h-1 w-3/5 rounded-full bg-primary-500" />
                <span class="h-1 w-4/5 rounded-full bg-content/25" />
            </span>
            <!-- A file opened in the middle of the editor. -->
            <span v-else-if="place === `viewers`" class="mx-auto my-1 w-4 rounded-2xs bg-primary-500/70" />
            <!-- A folder's own page, from the tree. -->
            <span v-else-if="place === `documents`" class="flex w-full flex-col gap-0.5 p-1.5">
                <span class="h-1 w-3/5 rounded-full bg-content/25" />
                <span class="h-1 w-4/5 rounded-full bg-primary-500" />
                <span class="h-1 w-3/5 rounded-full bg-content/25" />
            </span>
            <!-- The command palette, dropped from the top. -->
            <span v-else class="mx-auto mt-1 flex w-6 flex-col gap-0.5">
                <span class="h-1.5 rounded-2xs bg-primary-500" />
                <span class="h-1 w-4/5 rounded-full bg-content/25" />
            </span>
        </template>
        <Icon v-else :name="glyph" class="m-auto text-sm text-muted" />
    </span>
</template>
