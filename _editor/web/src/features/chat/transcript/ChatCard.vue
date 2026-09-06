<!-- ONE SHELL FOR EVERY CARD THAT ASKS THE USER SOMETHING: the surface, the header, and the divided row of
     answers under it. Eight cards use it — a plan, a question, a permission prompt, the browser and terminal
     help asks, and the service, payment and capability offers.

     IT EXISTS BECAUSE THEY HAD DRIFTED. Each one was written out by hand in ChatMessageView, four lines of
     identical Tailwind apiece, and identical-by-copy is a thing that stops being true: the question card ended
     up with a wrapping prose header at the body tier and no divider, the other seven with a truncated header a
     size up and a rule beneath it, and the permission card carried a comment saying it followed the question
     card's tier while its markup did the opposite. Three ways for one card, so a user answering two of them in
     one turn was reading two different components.

     THE QUESTION CARD'S CONVENTIONS ARE THE ONES KEPT, because they are the ones that were reasoned about
     rather than inherited: no divider under the header (the icon and the tier already separate it, and a rule
     under a two-line sentence reads as a banner), and the title at the BODY tier when it is a sentence. What
     is left of the old split is the `prose` prop below, which is a real difference between these cards rather
     than an accident of who wrote them.

     WHAT IT DOES NOT OWN, BUT NO LONGER LEAVES TO EACH CALLER: the body's spacing. Every card's body is
     different — markdown, a column of options, a program, a price — so the shell still does not wrap it, but
     the padding is one class (`chat-card-body` in chat.css, which explains the three numbers) rather than the
     `px-3.5 py-3` each card used to spell out for itself. That copy is exactly how the band under the header
     ended up wider on some cards than others. Rows of their own — the answers strip here, a running service's
     status line, a receipt — take `chat-card-row`, which carries its own band for the same reason. -->
<script lang="ts">
/* HOW A SETTLED CARD SAYS SO, and the only two shapes it may take. Every one of the eight ends either in
 * something happening (`done`, a check, the success colour) or in nothing happening (`gone`, a cross, muted) —
 * approved/answered/allowed/helped/connected against dismissed/denied/skipped/stopped/not-answered. Passing
 * the pair rather than markup is what keeps the chip one chip: it used to be a chain of four `v-if` spans per
 * card, restating the same two classes eight times over, which is exactly how one of them drifts. */
export interface CardStatus {
    readonly label: string;
    readonly tone: "done" | "gone";
}
</script>

<script setup lang="ts">
import { Icon, type IconName } from "@intentic/ui";

const {
    icon,
    iconClass = `text-primary-500`,
    title,
    status,
    prose = false,
} = defineProps<{
    icon: IconName;
    // The icon's tone. Not an enum: these are one Tailwind class and the set is small and legible at each site
    // (`text-link` for a plan, `text-warning` for the two help asks, primary for the rest).
    iconClass?: string;
    title: string;
    // Absent while the card is still live; present freezes it.
    status?: CardStatus;
    /* Whether the title is a SENTENCE rather than a name. A question ("Which library should we use?") and a
     * permission prompt ("This command would read credential material") are prose: they wrap in full, and they
     * sit at the body tier, because prose held a size above the thing it is asking about reads as a banner
     * shouted at the reader rather than as a question being asked. A plan's heading and an offer's "Run X?"
     * are names: one line, truncated, a size up. */
    prose?: boolean;
}>();
</script>

<template>
    <div class="chat-surface chat-card w-full overflow-hidden rounded-xl">
        <div class="chat-card-header flex gap-2 px-3.5 py-2" :class="prose ? `items-start` : `items-center`">
            <Icon :name="icon" class="text-sm" :class="[iconClass, { 'mt-0.5': prose }]" />
            <!-- A prose title wraps in full: it is the question, and truncating a question behind a tooltip
                 asks the reader to hover to find out what they are answering. A name truncates, with the full
                 text on hover, because a name that does not fit is still recognisable from its head. -->
            <span v-if="prose" class="chat-card-title min-w-0 flex-1 text-xs font-medium text-content">{{ title }}</span>
            <span v-else class="chat-card-title min-w-0 flex-1 truncate text-sm font-medium text-content" v-tooltip.left.overflow="title">{{
                title
            }}</span>
            <span
                v-if="status"
                class="shrink-0 text-2xs font-medium"
                :class="[status.tone === `done` ? `text-success` : `text-muted`, { 'mt-0.5': prose }]"
                >{{ status.tone === `done` ? `✓` : `✕` }} {{ status.label }}</span
            >
        </div>

        <slot />

        <!-- The answers. A divided row, and only when there are any: a settled card has none, and an empty
             bordered strip under it would read as a control that has stopped working. -->
        <div v-if="$slots[`actions`]" class="chat-card-row flex flex-wrap items-center gap-2">
            <slot name="actions" />
        </div>
    </div>
</template>
