<!-- ONE LANE OF A RAIL: the fleet board's kanban column at one card's width, and the frame every list of
     sessions in this app is drawn in: the floating chat's open chats (ChatTabList), the agents this
     sandbox's agents started (pages/Subagents.vue).

     It is a SLAB rather than a heading over loose cards (see .lane in styles.css): a rounded surface the
     lane's cards lie on, capped by its own header, separated from the next lane by a gap instead of by a
     colour change. The header is the slab's cap: full-bleed to the rounded top,
     painted in the lane's own fill so the two never seam, and PINNED while the lane scrolls, because a column
     this tall is read a screen at a time and a card only means "finished" while the lane it belongs to is
     still on screen. Its text starts where a card's content does, so the lane reads down one left edge.

     THE CAP'S CORNERS SURVIVE PINNING ONLY BECAUSE THE SURFACE DECLARES ITS GROUND. A radius shows what is
     behind it, and behind a pinned cap is the lane's own fill, so the corners are painted back on in the
     ground's colour (`.lane-header` in styles.css). That colour is `--lane-ground`, set by the surface that
     paints it — `lane-ground-card` on the floating chat's panel and /subagents, canvas everywhere else. A new
     host of this component either paints canvas or says what it paints.

     THE SCROLLER A LANE SITS IN MUST NOT CARRY TOP PADDING. A scroll container's padding insets where its
     sticky children come to rest but not where it clips, so a padded scroller pins this header below its own
     top edge and leaves a strip the cards scroll through in full view above the cap. Pad the frame AROUND the
     scroller instead: RailColumn does it for every rail, ChatTabs for the docked sheet.

     The count is a STRING because a filtered lane says "3 of 12": the denominator is the lane, not what
     survived the query, and a lane that silently shrinks is a lane that has stopped saying anything. -->
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
             slab's edge with `gap-2` between them (the <section> in AgentsView). They were a few pixels tighter
             here, and that is exactly the drift the two lists cannot afford: a rail row and a board card are one
             card in two frames, and a card sitting nearer its lane's edge in one of them reads as a different
             component rather than as the same one at another width.
             The header is opaque and ends exactly where the first card begins, so it paints over whatever that
             card draws at its top edge while the lane scrolls under it.
             THE HEIGHT IS FIXED for the board's reason (AgentsView says it at length): `#actions` is one lane's
             — "Clear" on Finished — and a cap that grew around a 26px button gave that lane a taller cap than
             the lanes above and below it, which down a rail reads as three headers that disagree. -->
        <header class="lane-header sticky top-0 z-10 flex h-8 shrink-0 items-center gap-2 rounded-t-xl px-3">
            <span v-if="dot !== undefined" class="h-2 w-2 shrink-0 rounded-full" :class="dot"></span>
            <Icon v-else-if="icon !== undefined" :name="icon" class="shrink-0 text-2xs text-subtle" />
            <span class="text-2xs font-semibold uppercase tracking-wide text-muted">{{ label }}</span>
            <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ count }}</span>
            <span class="flex-1"></span>
            <!-- The lane's own bulk act, where the lane is the target: "Clear" on Finished. -->
            <slot name="actions" />
        </header>
        <!-- The lane's contents, inset and spaced by the LANE rather than by each caller: three lists picking
             their own padding is how the rail and the board came apart in the first place. -->
        <div class="flex min-w-0 flex-col gap-2 px-2 pb-2">
            <slot />
        </div>
    </section>
</template>
