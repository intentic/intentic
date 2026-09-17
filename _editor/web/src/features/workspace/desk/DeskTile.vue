<!-- One desk tile: a glyph over a name, nothing else; the quick look on hover carries the facts. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { explorerColorClass, type IconName, iconForEntry } from "@intentic/ui";
import { computed } from "vue";

const {
    entry,
    selected = false,
    locked = false,
    pending = false,
    dimmed = false,
    tabindex = -1,
} = defineProps<{
    entry: WorkspaceTreeEntry;
    selected?: boolean;
    // Kept private by the sandbox: opens its explanation, never its contents.
    locked?: boolean;
    // Still arriving (an upload in flight): drawn where it will land, inert until the listing has it.
    pending?: boolean;
    // Ignored by tooling, or a link that goes nowhere.
    dimmed?: boolean;
    // Roving: the selected tile (or the first) is the one the Tab key reaches.
    tabindex?: number;
}>();

const emit = defineEmits<{ select: []; open: []; enter: [el: HTMLElement]; leave: [] }>();

const icon = computed<IconName>(() => (locked ? `lock` : iconForEntry(entry.name, entry.type)));
// Always the colourful hue, whatever the tree's own setup: a 2rem glyph in the minimal setup's grey reads as disabled.
const color = computed(() => (locked ? `text-subtle` : explorerColorClass(`colorful`, entry.name, entry.type, dimmed)));
const quiet = computed(() => dimmed || locked || pending);
</script>

<template>
    <button
        type="button"
        role="option"
        :aria-selected="selected"
        :data-desk-tile="entry.path"
        :tabindex="tabindex"
        class="ui-row-select flex w-full flex-col items-center gap-1.5 rounded-lg px-2 pt-3 pb-2 text-center select-none"
        :class="{ 'ui-row-select-on': selected, 'opacity-60': pending }"
        @click="emit('select')"
        @dblclick="emit('open')"
        @pointerenter="emit('enter', $event.currentTarget as HTMLElement)"
        @pointerleave="emit('leave')"
    >
        <span class="relative flex h-11 w-11 items-center justify-center">
            <Icon :name="icon" class="text-[2.125rem]" :class="color" />
            <!-- A link wears its target's glyph; the small mark says it is one. -->
            <Icon v-if="entry.link !== undefined" name="link" class="absolute -right-0.5 -bottom-0.5 text-[0.65rem] text-subtle" aria-label="Link" />
        </span>
        <span class="line-clamp-2 w-full text-xs leading-snug [overflow-wrap:anywhere]" :class="quiet ? 'text-subtle' : 'text-content/90'">{{
            entry.name
        }}</span>
    </button>
</template>
