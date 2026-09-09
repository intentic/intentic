<!--
    One lane of a rail (a kanban-style column), used by the fleet board and every session list. Its header stays pinned while the lane scrolls; the
    host must set `--lane-ground` (lane-ground-card, or canvas) so the pinned corners repaint correctly. Do not pad the scroller's top — pad the
    surrounding frame instead.
-->
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
        <!-- THE BOARD'S OWN LANE MEASUREMENTS, to the pixel: header `h-8 px-3`, cards inset `px-2` from the
             slab's edge with `gap-2.5` between them (the <section> in AgentsView). They were a few pixels tighter
             here, and that is exactly the drift the two lists cannot afford: a rail row and a board card are one
             card in two frames, and a card sitting nearer its lane's edge in one of them reads as a different
             component rather than as the same one at another width.
             The header is opaque and ends exactly where the first card begins, so it paints over whatever that
             card draws at its top edge while the lane scrolls under it.
             THE HEIGHT IS FIXED for the board's reason (AgentsView says it at length): `#actions` comes and goes
             per lane, and a cap that grew around a 26px button gave the lanes carrying one a taller cap than the
             lanes above and below them, which down a rail reads as three headers that disagree. -->
        <header class="lane-header sticky top-0 z-10 flex h-8 shrink-0 items-center gap-2 rounded-t-xl px-3">
            <span v-if="dot !== undefined" class="h-2 w-2 shrink-0 rounded-full" :class="dot"></span>
            <Icon v-else-if="icon !== undefined" :name="icon" class="shrink-0 text-2xs text-subtle" />
            <span class="text-2xs font-semibold uppercase tracking-wide text-muted">{{ label }}</span>
            <!-- THE NUMBER WITHOUT THE PILL. It stays because it is the only thing on screen that can say what is
                 NOT on screen — the Finished lane windows itself, so "12" above six rows is the fact the rows
                 cannot state, and under a filter it reads "3 of 12". The `bg-overlay` capsule around it was doing
                 none of that work: three filled chips down a narrow rail read as controls rather than as counts,
                 and they were the heaviest thing in a header whose own label is 11px muted uppercase. -->
            <span data-lane-count class="text-2xs tabular-nums text-subtle">{{ count }}</span>
            <span class="flex-1"></span>
            <!-- The lane's own bulk act, where the lane is the target: "Clear". -->
            <slot name="actions" />
        </header>
        <!-- The lane's contents, inset and spaced by the LANE rather than by each caller: three lists picking
             their own padding is how the rail and the board came apart in the first place.
             `gap-2.5` is the board's actual figure, and this had drifted to `gap-2` while the comment above still
             claimed they matched — which is the drift those comments exist to prevent, arriving as 2px. -->
        <div class="flex min-w-0 flex-col gap-2.5 px-2 pb-2">
            <slot />
        </div>
    </section>
</template>
