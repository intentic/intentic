import type { IconName } from "@intentic/ui";
import type { Component } from "vue";
import { computed, ref, shallowReactive } from "vue";

// Every floating message the app raises, in one store, for one lane (shell/NotificationHost.vue). Three kinds,
// and the kind is the whole of the difference:
//
// 1. `receipt`: happened and is over. Retires itself, at most one action back.
// 2. `condition`: true right now. Stays exactly as long as it is true.
// 3. `question`: the user owes an answer. Only answering or dismissing retires it.

export type NotificationKind = "receipt" | "condition" | "question";

// Picks the glyph and card colour only; the box is otherwise identical for every tone. `done`/`problem` are the
// receipt's pair (worked / didn't).
export type NotificationTone = "done" | "problem" | "info" | "warning" | "danger";

export interface NotificationAction {
    readonly label: string;
    readonly run: () => void | Promise<void>;
    readonly severity?: "primary" | "secondary" | "warn";
    /** A tooltip, where the label alone cannot say what the press costs or which shortcut also does it. */
    readonly hint?: string;
}

export interface NotificationInput {
    readonly kind: NotificationKind;
    readonly tone?: NotificationTone;
    /** The app's own words, in the past tense for a receipt. Never a caught error message — that is `detail`. */
    readonly title: string;
    /** The second line: the cause, the cost of the button, what happens if it is ignored. */
    readonly detail?: string;
    /** Overrides the tone's glyph, for the rare case where the icon carries something the tone does not. */
    readonly icon?: IconName;
    readonly spin?: boolean;
    /** The long explanation behind the card's info icon; for the paragraph nobody needs but somebody will want. */
    readonly hint?: string;
    /** Escape hatch: a component rendered under the text, for content that isn't two strings. */
    readonly body?: Component;
    /** A card that needs room for its body; widens the lane and stays right-aligned. */
    readonly wide?: boolean;
    /** At most two; three buttons on a floating card is an unblocked dialog. */
    readonly actions?: readonly NotificationAction[];
    /** Presence puts a close button on the card; the owner records the dismissal, not the host. */
    readonly dismiss?: () => void;
}

export interface Notification extends NotificationInput {
    readonly id: string;
    readonly tone: NotificationTone;
}

// id to getter, called on every read; shallowReactive tracks membership, not the (plain) getters themselves.
const sources = shallowReactive(new Map<string, () => NotificationInput | undefined>());

// A counter, not a timestamp: two receipts in the same millisecond still need distinct ids.
const receipt = ref<Notification | undefined>(undefined);
let raised = 0;

const RECEIPT_ID = `receipt`;

// Lane order, not severity: the receipt (frequent) rides on top, a question (fixed) takes the corner.
const TIER: Record<NotificationKind, number> = { receipt: 0, condition: 1, question: 2 };

const held = computed<readonly Notification[]>(() =>
    [...sources]
        .map(([id, read]) => {
            const input = read();
            return input === undefined ? undefined : { ...input, id, tone: input.tone ?? `info` };
        })
        .filter((entry): entry is Notification => entry !== undefined),
);

/** Everything on screen, in lane order; registration order breaks ties within a tier. */
const notifications = computed<readonly Notification[]>(() =>
    [...(receipt.value === undefined ? [] : [receipt.value]), ...held.value].sort((a, b) => TIER[a.kind] - TIER[b.kind]),
);

/**
 * Declares a condition or question as a pure function of state; returns a stopper. Re-registering the same id
 * replaces it, so a remounted component is idempotent, not doubled.
 */
export const hold = (id: string, source: () => NotificationInput | undefined): (() => void) => {
    sources.set(id, source);
    return (): void => {
        sources.delete(id);
    };
};

export const useNotifications = () => {
    // Confirms success without asking for anything back. Raising one replaces whatever is showing; the host watches
    // this ref, so a new receipt restarts the dwell.
    const say = (message: string, undo?: () => void | Promise<void>, undoHint?: string): void => {
        raised += 1;
        receipt.value = {
            id: `${RECEIPT_ID}:${raised}`,
            kind: `receipt`,
            tone: `done`,
            title: message,
            actions: undo === undefined ? undefined : [{ label: `Undo`, run: undo, hint: undoHint }],
        };
    };

    // A calm failure: nothing broke, nothing to fix but wait, so it shares the receipt's self-retiring channel with a
    // different tone. A failure the user must act on is a `question` instead.
    const warn = (message: string): void => {
        raised += 1;
        receipt.value = { id: `${RECEIPT_ID}:${raised}`, kind: `receipt`, tone: `problem`, title: message };
    };

    const dismissReceipt = (): void => {
        receipt.value = undefined;
    };

    return { notifications, receipt, say, warn, dismissReceipt, hold };
};
