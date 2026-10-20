<!-- Shared shell for cards that ask the user something. -->
<script lang="ts">
// Shared shell for every card that asks the user something: header, slot, and the answers below. Every title sits at the
// body tier and carries its weight, whether it is a sentence or a name. Every inset comes from `.chat-card`'s own
// measures in chat.css, not from each card.
// A LIVE card wears its tone (the icon's colour, and the skin's accent on the title); a settled one is history and
// drops to the ink of the words around it, so the one card still waiting is the one that stands out.
export interface CardStatus {
    readonly label: string;
    readonly tone: "done" | "gone";
}
</script>

<script setup lang="ts">
import { Icon, type IconName } from "@intentic/ui";

const {
    icon,
    iconClass = `text-accent`,
    title,
    status,
    prose = false,
} = defineProps<{
    icon: IconName;
    // Icon's tone as a single Tailwind class; the set is small enough not to need an enum.
    iconClass?: string;
    title: string;
    // Absent while the card is still live; present freezes it.
    status?: CardStatus;
    // Whether the title is a sentence (wraps, body tier) rather than a name (truncates, one size up).
    prose?: boolean;
}>();
</script>

<template>
    <!-- `data-card-live` marks a card still waiting on its answer, for the bar above the composer to scroll to (ChatWaitingBar). -->
    <div
        class="chat-card w-full overflow-hidden"
        :class="status === undefined ? `chat-card-live` : `chat-card-settled`"
        :data-card-live="status === undefined ? `` : undefined"
    >
        <!-- The icon rides in the mark column every option row under it also uses, so the title and the labels start on one edge. -->
        <div class="chat-card-header text-xs" :class="prose ? `items-start` : `items-center`">
            <Icon :name="icon" class="text-sm" :class="status === undefined ? iconClass : `text-subtle`" />
            <!-- A prose title wraps in full; a name truncates, with the full text on hover. One size and weight for both:
                 which kind a title is was never something a reader could see, so it may not set how loud it is. -->
            <!-- Semibold, not medium: with no rim or ground left on a card, weight is what keeps the ask above the labels answering it. -->
            <span v-if="prose" class="chat-card-title min-w-0 text-xs font-semibold text-content">{{ title }}</span>
            <span v-else class="chat-card-title min-w-0 truncate text-xs font-semibold text-content" v-tooltip.left.overflow="title">{{
                title
            }}</span>
            <!-- How it ended, as a note beside the title rather than a second heading: the label in the meta ink, and only
                 the glyph saying whether it went through. -->
            <span v-if="status" class="inline-flex shrink-0 items-center gap-1 text-2xs text-muted" :class="{ 'mt-0.5': prose }">
                <Icon :name="status.tone === `done` ? `check` : `times`" :class="status.tone === `done` ? `text-success` : `text-subtle`" />
                {{ status.label }}
            </span>
        </div>

        <slot />

        <!-- Answers row, rendered only when there are any; an empty strip would read as a missing element. -->
        <div v-if="$slots[`actions`]" class="chat-card-row chat-card-actions flex flex-wrap items-center gap-2">
            <slot name="actions" />
        </div>
    </div>
</template>
