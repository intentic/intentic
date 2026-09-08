<script setup lang="ts">
import { Button, Icon, type IconName, InfoHint, useDevice } from "@intentic/ui";
import { onBeforeUnmount, ref, watch } from "vue";
import { type Notification, type NotificationAction, type NotificationTone, useNotifications } from "./notifications";

// The one place the app floats anything over itself: the store decides what and why, this file is the lane
// (layout, card shape, timing). The wrapper is inert; only the cards catch pointer events. It grows upward from
// the bottom-right, last item anchored, so receipts (frequent) come first and questions (fixed point) last.

const { notifications, receipt, dismissReceipt } = useNotifications();
const { mobile } = useDevice();

// Long enough to read the sentence and reach for Undo; short enough to read as something that just happened.
const RECEIPT_MS = 7_000;
// Longer than RECEIPT_MS: a problem's sentence is longer, and expiring unread leaves a button that did nothing.
const PROBLEM_MS = 12_000;

// Holds the hovered receipt's id: a boolean could stick true if Undo removes the card without a mouseleave.
const hoveredId = ref<string>();
const announcement = ref(``);
let timer: ReturnType<typeof setTimeout> | undefined;

// `immediate`: a receipt can already be standing when this mounts, and one with no timer under it never leaves.
watch(
    [receipt, hoveredId],
    () => {
        clearTimeout(timer);
        if (receipt.value === undefined) {
            return;
        }
        announcement.value = receipt.value.title;
        if (hoveredId.value !== receipt.value.id) {
            timer = setTimeout(dismissReceipt, receipt.value.tone === `problem` ? PROBLEM_MS : RECEIPT_MS);
        }
    },
    { immediate: true },
);

onBeforeUnmount(() => clearTimeout(timer));

// Tone changes only the glyph and colour; every card is otherwise the same box.
const GLYPH: Record<NotificationTone, IconName> = {
    done: `check`,
    problem: `exclamation-circle`,
    info: `info-circle`,
    warning: `exclamation-triangle`,
    danger: `exclamation-triangle`,
};
const TINT: Record<NotificationTone, string> = {
    done: `text-success`,
    problem: `text-warning`,
    info: `text-info`,
    warning: `text-warning`,
    danger: `text-danger`,
};

// Receipt width fits its sentence; other cards take the lane's width or more if they carry a body. All
// right-align, but below `sm` they span the full lane so a narrow phone doesn't misalign.
const widthOf = (entry: Notification): string =>
    entry.kind === `receipt` ? `w-full sm:w-auto sm:max-w-[22rem]` : entry.wide ? `w-full sm:w-[32rem]` : `w-full sm:w-[22rem]`;

// Whether the card is a single line or has a detail row below: a bare sentence stays one line, keeping actions on
// the same row rather than reading as a new item.
const compact = (entry: Notification): boolean => entry.detail === undefined && entry.body === undefined;

// A question interrupts (`alert`); a condition is announced politely (`status`); a receipt gets no role since the
// live region below already reads it, avoiding a double announcement.
const roleOf = (entry: Notification): string | undefined => (entry.kind === `question` ? `alert` : entry.kind === `condition` ? `status` : undefined);

// An action retires its own receipt: what it reported is no longer true. A held item isn't the host's to remove;
// its source decides when it stops being true.
const press = (entry: Notification, action: NotificationAction): void => {
    if (entry.kind === `receipt`) {
        dismissReceipt();
    }
    void action.run();
};
</script>

<template>
    <!--
        Clipped by the viewport from the top, not scrolled, so an overflowing lane loses the receipt first (it retires
        itself) while the fixed question stays reachable.
    -->
    <div
        class="pointer-events-none fixed inset-x-3 z-50 flex max-h-[calc(100dvh-1.5rem)] flex-col items-end justify-end gap-2 overflow-hidden sm:left-auto sm:right-3 sm:max-w-[calc(100vw-1.5rem)]"
        :class="mobile ? `bottom-[calc(4.25rem+env(safe-area-inset-bottom))]` : `bottom-3`"
    >
        <Transition v-for="entry in notifications" :key="entry.id" name="lane">
            <!--
                Two columns, not an icon beside a stack: the glyph is a grid item in the title's row (`self-center`); everything
                below is `col-start-2` to stay indented past it.
            -->
            <div
                class="pointer-events-auto grid max-w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-lg border border-line-strong bg-card p-3 shadow-lg"
                :class="widthOf(entry)"
                :role="roleOf(entry)"
                @mouseenter="entry.kind === `receipt` && (hoveredId = entry.id)"
                @mouseleave="entry.kind === `receipt` && hoveredId === entry.id && (hoveredId = undefined)"
            >
                <Icon
                    :name="entry.icon ?? GLYPH[entry.tone]"
                    class="self-center text-xs"
                    :class="TINT[entry.tone]"
                    :spin="entry.spin === true"
                    aria-hidden="true"
                />
                <div class="flex min-w-0 items-center gap-2">
                    <!-- Wraps rather than truncating: a problem or condition needs the full reason, not an ellipsis mid-sentence. -->
                    <p class="min-w-0 flex-1 break-words text-xs font-medium text-content">{{ entry.title }}</p>
                    <!-- The one-line card keeps its press on the sentence's own row. -->
                    <Button
                        v-for="action in compact(entry) ? (entry.actions ?? []) : []"
                        :key="action.label"
                        size="small"
                        :severity="action.severity ?? `secondary`"
                        :label="action.label"
                        class="shrink-0"
                        v-tooltip.top="action.hint"
                        @click="press(entry, action)"
                    />
                    <!-- The paragraph nobody needs but somebody will want, kept off the card until asked for. -->
                    <InfoHint v-if="entry.hint" class="shrink-0" :label="entry.title">
                        <span class="block text-xs text-content">{{ entry.hint }}</span>
                    </InfoHint>
                    <!-- Kept to one line's height: as a full-height sibling it stretches a gutter down the whole card. -->
                    <button
                        v-if="entry.dismiss"
                        type="button"
                        class="shrink-0 cursor-pointer rounded p-0.5 text-muted transition-colors hover:text-content"
                        aria-label="Dismiss"
                        @click="entry.dismiss()"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                </div>
                <p v-if="entry.detail" class="col-start-2 mt-0.5 break-words text-2xs text-muted">{{ entry.detail }}</p>
                <!-- Escape hatch for content that isn't two strings, e.g. a composed turn or per-folder upload progress. -->
                <component :is="entry.body" v-if="entry.body" class="col-start-2 mt-2" />
                <div v-if="!compact(entry) && entry.actions && entry.actions.length > 0" class="col-start-2 mt-2 flex items-center justify-end gap-1">
                    <Button
                        v-for="action in entry.actions"
                        :key="action.label"
                        size="small"
                        :severity="action.severity ?? `secondary`"
                        :label="action.label"
                        v-tooltip.top="action.hint"
                        @click="press(entry, action)"
                    />
                </div>
            </div>
        </Transition>
    </div>
    <!-- Announces what the cards can't: politely, since only a question's own `role="alert"` may interrupt. -->
    <span class="sr-only" aria-live="polite">{{ announcement }}</span>
</template>

<style scoped>
/* Same direction in and out, so an expiring card and a dismissed one read as the same object leaving. */
.lane-enter-active,
.lane-leave-active {
    transition:
        transform 200ms ease,
        opacity 200ms ease;
}
.lane-enter-from,
.lane-leave-to {
    opacity: 0;
    transform: translateY(0.5rem);
}
</style>
