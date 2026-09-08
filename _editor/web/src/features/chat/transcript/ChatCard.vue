<!--
    Shared shell (surface, header, divided answer row) for every card that asks the user something — plan, question, permission, browser/terminal
    help, service/payment/capability offers. No divider under the header; the title renders at the body tier when it is a sentence (`prose` prop).
    Body padding is `chat-card-body` or `chat-card-row` in chat.css; the shell does not otherwise lay out the body.
-->
<script lang="ts">
// Shared shell for every card that asks the user something: header, slot, and a divided row of answers below. No
// divider under the header; a prose title sits at the body tier. Body and row padding come from
// `chat-card-body`/`chat-card-row` in chat.css, not from each card.
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
    <div class="chat-surface chat-card w-full overflow-hidden rounded-xl">
        <div class="chat-card-header flex gap-2 px-3.5 py-2" :class="prose ? `items-start` : `items-center`">
            <Icon :name="icon" class="text-sm" :class="[iconClass, { 'mt-0.5': prose }]" />
            <!-- A prose title wraps in full; a name truncates, with the full text on hover. -->
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

        <!-- Divided answers row, shown only when there are any; an empty bordered strip would look broken. -->
        <div v-if="$slots[`actions`]" class="chat-card-row flex flex-wrap items-center gap-2">
            <slot name="actions" />
        </div>
    </div>
</template>
