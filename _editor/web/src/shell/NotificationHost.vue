<script setup lang="ts">
import { Button, Icon, type IconName, InfoHint, useDevice } from "@intentic/ui";
import { onBeforeUnmount, ref, watch } from "vue";
import { type Notification, type NotificationAction, type NotificationTone, useNotifications } from "../composables/notifications";

/* THE ONE PLACE THIS APP FLOATS ANYTHING OVER ITSELF.
 *
 * The store (composables/notifications.ts) says what is on screen and why. What lives here is the LANE: one
 * bottom-right column, one card shape, one z-tier, and the timing — because the timing depends on the pointer,
 * which is a view's business and not a store's.
 *
 * WHY BOTTOM RIGHT AND WHY ONLY ONE. Before this there were four anchors (top centre, bottom centre, bottom
 * centre plus a hardcoded 64px, and a bottom-right corner that three unrelated components each believed was
 * theirs alone). None of that was legible: position said nothing about what kind of message it was, and two
 * cards choosing the same corner simply overlapped, because no one of them could know about the others. A lane
 * fixes both at once. Everything is in one place, so there is one place to look; and everything is in one
 * component, so stacking is arithmetic instead of luck.
 *
 * IT GROWS UPWARD FROM THE CORNER, which is the whole reason the store orders items the way it does: the last
 * child is anchored and the first child is the one that moves. Receipts are first, so the thing that comes and
 * goes several times a minute never shifts a card someone is reading or reaching for; questions are last, so
 * the thing still owed an answer sits at the fixed point the eye already knows.
 *
 * THE WRAPPER IS INERT AND THE CARDS ARE NOT, or the lane would eat clicks on whatever it floats over — the
 * chat panel and the workspace tree both run all the way into this corner.
 *
 * ON MOBILE IT CLEARS THE TAB BAR rather than sitting on it. The bar is the app's primary navigation at that
 * width; a card parked over it would cover a destination, and a card that covers a destination is a card people
 * learn to close before reading. */

const { notifications, receipt, dismissReceipt } = useNotifications();
const { mobile } = useDevice();

// Long enough to read a short sentence and reach for the Undo, short enough that it reads as "that just
// happened" rather than as a new thing on screen.
const RECEIPT_MS = 7_000;
// A problem gets longer, because its sentence is longer and it is doing more work: a completion confirms
// something the user already expected, while this one is telling them why the thing they asked for did not
// arrive, and if it expires unread they are back to a button that did nothing.
const PROBLEM_MS = 12_000;

/* A receipt PAUSES while hovered. Vanishing under the cursor that came for its Undo would fail the affordance
 * at the only moment it is ever wanted. The window restarts on each new receipt: the watch reads the ref
 * itself, so replacing it re-arms the full dwell rather than inheriting the tail of the one before. */
const hovered = ref(false);
const announcement = ref(``);
let timer: ReturnType<typeof setTimeout> | undefined;

/* `immediate`, because a receipt can already be standing when this mounts and a receipt with no timer under it
 * never leaves. The old host got away without it by being mounted before anything could report; that was a fact
 * about the component tree rather than a guarantee, and it stops being true the moment a module-scoped watcher
 * (draftingReceipts.ts) reports during another component's setup. */
watch(
    [receipt, hovered],
    () => {
        clearTimeout(timer);
        if (receipt.value === undefined) {
            return;
        }
        announcement.value = receipt.value.title;
        if (!hovered.value) {
            timer = setTimeout(dismissReceipt, receipt.value.tone === `problem` ? PROBLEM_MS : RECEIPT_MS);
        }
    },
    { immediate: true },
);

onBeforeUnmount(() => clearTimeout(timer));

/* ONE GLYPH AND ONE COLOUR APART, and nothing else. Every card here is the same box: a message that changed
 * shape with its severity would be the five separate components this file replaced. */
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

/* A receipt shrinks to its sentence; everything else takes the lane's width, and a card carrying a body that
 * needs room (a proposed agent turn, a per-folder upload breakdown) takes more. All three right-align, so the
 * stack has one edge however mixed it is.
 *
 * Below `sm` they all span the lane instead, because a 22rem card on a 390px phone leaves 12px of margin on one
 * side and 26px on the other, which reads as a misalignment rather than as a width. */
const widthOf = (entry: Notification): string =>
    entry.kind === `receipt` ? `w-auto max-w-full` : entry.wide ? `w-full sm:w-[32rem]` : `w-full sm:w-[22rem]`;

/* ONE LINE OR TWO ROWS, decided by whether the card has anything to say under its sentence. "3 files deleted"
 * with its Undo banished to a row of its own is a two-line card carrying three words, which is the shape that
 * made the old receipt a pill instead: it read as a new thing on screen rather than as a footnote to the press
 * that caused it. A card with a detail line or a body has the height already, and its buttons want the
 * bottom-right corner where buttons belong. */
const compact = (entry: Notification): boolean => entry.detail === undefined && entry.body === undefined;

/* WHAT EACH CARD IS TO A SCREEN READER, and the receipt's silence here is deliberate. A question INTERRUPTS
 * (`alert`), because it is the one thing on screen the user still owes something to. A condition is announced
 * politely, when there is a gap. A receipt gets NO role at all: it is already read out by the one live region
 * below, and a card that carries `status` as well would say every completion twice — once as a region update
 * and once as the card mounting. */
const roleOf = (entry: Notification): string | undefined => (entry.kind === `question` ? `alert` : entry.kind === `condition` ? `status` : undefined);

// An action retires the receipt it belongs to: the thing it was reporting is no longer true. A held item is not
// the host's to remove — its source decides when it stops being true (see `hold` in the store).
const press = (entry: Notification, action: NotificationAction): void => {
    if (entry.kind === `receipt`) {
        dismissReceipt();
    }
    void action.run();
};
</script>

<template>
    <!-- CAPPED AT THE VIEWPORT, clipping from the TOP, which is the other half of why the store orders items the
         way it does. A bottom-anchored column with nothing stopping it simply grows off the top of the screen,
         and what it takes with it is whatever it was told about last. Clipping instead of scrolling because a
         scrollbar here would be a notification centre, and clipping the FIRST item is the cheap end: that is the
         receipt, which retires by itself in seconds, while the question in the corner cannot be pushed anywhere. -->
    <div
        class="pointer-events-none fixed inset-x-3 z-50 flex max-h-[calc(100dvh-1.5rem)] flex-col items-end justify-end gap-2 overflow-hidden sm:left-auto sm:right-3 sm:max-w-[calc(100vw-1.5rem)]"
        :class="mobile ? `bottom-[calc(4.25rem+env(safe-area-inset-bottom))]` : `bottom-3`"
    >
        <TransitionGroup name="lane">
            <div
                v-for="entry in notifications"
                :key="entry.id"
                class="pointer-events-auto flex max-w-full items-start gap-2 rounded-lg border border-line-strong bg-card p-3 shadow-lg"
                :class="widthOf(entry)"
                :role="roleOf(entry)"
                @mouseenter="entry.kind === `receipt` && (hovered = true)"
                @mouseleave="entry.kind === `receipt` && (hovered = false)"
            >
                <Icon
                    :name="entry.icon ?? GLYPH[entry.tone]"
                    class="mt-1 shrink-0 text-xs"
                    :class="TINT[entry.tone]"
                    :spin="entry.spin === true"
                    aria-hidden="true"
                />
                <div class="min-w-0 flex-1">
                    <div class="flex min-w-0 items-center gap-2">
                        <!-- A completion is three words and wrapping it never bites; a problem or a condition
                             has to say what and why, so it wraps rather than ending in an ellipsis mid-reason. -->
                        <p class="min-w-0 flex-1 text-xs font-medium text-content">{{ entry.title }}</p>
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
                        <!-- The paragraph nobody needs but somebody will want, kept off the card until it is
                             asked for. -->
                        <InfoHint v-if="entry.hint" class="shrink-0" :label="entry.title">
                            <span class="block text-xs text-content">{{ entry.hint }}</span>
                        </InfoHint>
                        <!-- Dismiss is the OWNER'S to record, never the host's to fake: it runs their callback
                             and the card leaves on the next tick because their source has gone quiet.

                             THESE TWO RIDE THE TITLE'S ROW rather than the card's full height, which is not a
                             cosmetic choice. As siblings of the whole text column they took a 24px gutter down
                             the ENTIRE card: the progress bar of an upload stopped 24px short of the padding it
                             was supposed to meet, every detail line wrapped early against nothing, and the card
                             had a ragged right edge that no amount of padding could explain. They are one line
                             tall, so they may only cost one line's width. -->
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
                    <p v-if="entry.detail" class="mt-0.5 break-words text-2xs text-muted">{{ entry.detail }}</p>
                    <!-- The escape hatch, under the text where a caption belongs: the items whose content is not
                         two strings (a composed agent turn, an upload's per-folder progress). -->
                    <component :is="entry.body" v-if="entry.body" class="mt-2" />
                    <div v-if="!compact(entry) && entry.actions && entry.actions.length > 0" class="mt-2 flex items-center justify-end gap-1">
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
            </div>
        </TransitionGroup>
    </div>
    <!-- What the lane cannot tell a screen reader. Polite: a completion never interrupts. Questions carry
         `role="alert"` on the card itself, which is the one thing here allowed to. -->
    <span class="sr-only" aria-live="polite">{{ announcement }}</span>
</template>

<style scoped>
/* Rises into place and sinks out of it: the same direction both ways, so a card that expires on its own and one
 * dismissed by a press read as the same object leaving. `lane-move` is what makes the stack settle rather than
 * jump when something below a card retires. */
.lane-enter-active,
.lane-leave-active,
.lane-move {
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
