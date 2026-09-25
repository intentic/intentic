<!-- A lane's header: its mark, its name and how many it holds, then its own bulk act. The one drawing of it, for the
     fleet board's columns, the chat rail and the subagent list alike (RailLane wraps it). Paints nothing and sets no
     horizontal padding: the board's cards run edge to edge under `px-1`, a rail's are inset by its lane, and each caller
     insets the header to sit 4px inside its cards. -->
<script setup lang="ts">
import type { IconName } from "@intentic/ui";

defineProps<{
    label?: string;
    // The lane's mark: the board's own coloured dot for a lane of the fleet, or a glyph for a group that is
    // not one (the rail's "Not open" search hits).
    dot?: string;
    icon?: IconName;
    count?: string | number;
}>();
</script>

<template>
    <header class="flex h-8 shrink-0 items-center gap-2">
        <!-- A header that stands for something else for a while (the board's archive) draws its own mark and name. -->
        <slot name="mark">
            <span v-if="dot !== undefined" class="h-2 w-2 shrink-0 rounded-full" :class="dot"></span>
            <Icon v-else-if="icon !== undefined" :name="icon" class="shrink-0 text-2xs text-subtle" />
            <span class="text-2xs font-semibold uppercase tracking-wide text-muted">{{ label }}</span>
        </slot>
        <span v-if="count !== undefined" data-lane-count class="text-2xs tabular-nums text-subtle">{{ count }}</span>
        <span class="flex-1"></span>
        <!-- The lane's own bulk act, where the lane is the target: "Clear". -->
        <slot name="actions" />
    </header>
</template>
