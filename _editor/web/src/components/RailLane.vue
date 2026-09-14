<!-- One lane of a rail (a kanban-style column), used by the fleet board and every session list. -->
<script setup lang="ts">
import type { IconName } from "@intentic/ui";

defineProps<{
    label: string;
    // The lane's mark: the board's own coloured dot for a lane of the fleet, or a glyph for a group that is
    // not one (the rail's "Not open" search hits).
    dot?: string;
    icon?: IconName;
    count: string | number;
}>();
</script>

<template>
    <section class="lane flex min-w-0 flex-col rounded-xl">
<!-- THE BOARD'S OWN LANE MEASUREMENTS, to the pixel: header `h-8 px-3`. -->
        <header class="lane-header sticky top-0 z-10 flex h-8 shrink-0 items-center gap-2 rounded-t-xl px-3">
            <span v-if="dot !== undefined" class="h-2 w-2 shrink-0 rounded-full" :class="dot"></span>
            <Icon v-else-if="icon !== undefined" :name="icon" class="shrink-0 text-2xs text-subtle" />
            <span class="text-2xs font-semibold uppercase tracking-wide text-muted">{{ label }}</span>
<!-- THE NUMBER WITHOUT THE PILL. -->
            <span data-lane-count class="text-2xs tabular-nums text-subtle">{{ count }}</span>
            <span class="flex-1"></span>
            <!-- The lane's own bulk act, where the lane is the target: "Clear". -->
            <slot name="actions" />
        </header>
<!-- The lane's contents, inset and spaced by the LANE rather than by each caller. -->
        <div class="flex min-w-0 flex-col gap-2.5 px-2 pb-2">
            <slot />
        </div>
    </section>
</template>
