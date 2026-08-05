<!-- ONE LANE OF A RAIL — the fleet board's kanban column at one card's width, and the frame every list of
     sessions in this app is drawn in: the popped-out chat's open chats (ChatTabList), the agents this
     sandbox's agents started (pages/Subagents.vue).

     It is a SLAB rather than a heading over loose cards (see .lane in styles.css): a rounded surface the
     lane's cards lie on, capped by its own header, separated from the next lane by a gap instead of by a
     colour change. The header is the slab's cap — full-bleed to the rounded top through the negative margins,
     painted in the lane's own fill so the two never seam, and PINNED while the lane scrolls, because a column
     this tall is read a screen at a time and a card only means "finished" while the lane it belongs to is
     still on screen. Its text starts where a card's content does, so the lane reads down one left edge.

     THE SCROLLER A LANE SITS IN MUST NOT CARRY TOP PADDING. A scroll container's padding insets where its
     sticky children come to rest but not where it clips, so a padded scroller pins this header below its own
     top edge and leaves a strip the cards scroll through in full view above the cap. Pad the frame AROUND the
     scroller instead — ChatTabs pads the sheet, pages/Subagents.vue the rail's column.

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
    <section class="lane flex min-w-0 flex-col rounded-xl p-1">
        <header class="lane-header sticky top-0 z-10 -mx-1 -mt-1 flex items-center gap-2 rounded-t-xl px-3.5 pb-2 pt-2.5">
            <span v-if="dot !== undefined" class="h-2 w-2 shrink-0 rounded-full" :class="dot"></span>
            <Icon v-else-if="icon !== undefined" :name="icon" class="shrink-0 text-2xs text-subtle" />
            <span class="text-2xs font-semibold uppercase tracking-wide text-muted">{{ label }}</span>
            <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ count }}</span>
            <span class="flex-1"></span>
            <!-- The lane's own bulk act, where the lane is the target — "Clear" on Finished. -->
            <slot name="actions" />
        </header>
        <slot />
    </section>
</template>
