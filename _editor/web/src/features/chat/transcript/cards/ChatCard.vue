<!--
    Shared shell (header, body, answer row) for every card that asks the user something — plan, question, permission, browser/terminal help,
    service/payment/capability offers. No ground and no rim: what holds a card together is one text column, which `.chat-card` states as an
    inset, a mark box and the gap between them (chat.css). The title renders at the body tier when it is a sentence (`prose` prop).
-->
<script lang="ts">
// Shared shell for every card that asks the user something: header, slot, and the answers below. A prose title sits at
// the body tier. Every inset comes from `.chat-card`'s own measures in chat.css, not from each card.
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
    <div class="chat-card w-full overflow-hidden">
        <!-- The icon rides in the mark column every option row under it also uses, so the title and the labels start on one edge. -->
        <div class="chat-card-header" :class="prose ? `items-start` : `items-center`">
            <Icon :name="icon" class="text-sm" :class="[iconClass, { 'mt-0.5': prose }]" />
            <!-- A prose title wraps in full; a name truncates, with the full text on hover. -->
            <!-- Semibold, not medium: with no rim or ground left on a card, weight is what keeps the ask above the labels answering it. -->
            <span v-if="prose" class="chat-card-title min-w-0 text-xs font-semibold text-content">{{ title }}</span>
            <span v-else class="chat-card-title min-w-0 truncate text-sm font-medium text-content" v-tooltip.left.overflow="title">{{ title }}</span>
            <span
                v-if="status"
                class="shrink-0 text-2xs font-medium"
                :class="[status.tone === `done` ? `text-success` : `text-muted`, { 'mt-0.5': prose }]"
                >{{ status.tone === `done` ? `✓` : `✕` }} {{ status.label }}</span
            >
        </div>

        <slot />

        <!-- Answers row, rendered only when there are any; an empty strip would read as a missing element. -->
        <div v-if="$slots[`actions`]" class="chat-card-row flex flex-wrap items-center gap-2">
            <slot name="actions" />
        </div>
    </div>
</template>
