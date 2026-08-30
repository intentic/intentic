import type { IconName } from "@intentic/ui";
import type { Component } from "vue";
import { computed, ref, shallowReactive } from "vue";

/* EVERY FLOATING MESSAGE THIS APP RAISES, IN ONE STORE, FOR ONE LANE.
 *
 * WHAT WAS WRONG. The app had grown eight of these and no two agreed on anything. A receipt was a pill at the
 * bottom centre; the agents board drew its own copy of that pill, with its own store, its own timer and its own
 * transition, forty lines away from the shared one. A stale build and a degraded connection were both cards at
 * the bottom right, at the same z-tier, neither aware of the other, so the second one to appear simply sat on
 * the first. The shortcut offer dodged the receipt lane with a hardcoded `bottom-16`, a number that was only
 * correct while both cards kept the height they happened to have. A push that failed and a sandbox catching its
 * breath both took the top of the viewport, from different tiers. And the composer said "The sandbox is busy"
 * as raw text at the same moment the gate said it in a pill fourteen hundred pixels away.
 *
 * A user cannot learn a system like that, because there is no system: where a message appears says nothing
 * about what kind of message it is, only about which file happened to draw it.
 *
 * WHAT IT IS NOW. One lane, bottom right (shell/NotificationHost.vue). One store, this file. Everything that
 * floats over the app goes through here, and the only thing that varies between items is how long they stay
 * and what you can press on them, which is exactly the thing that SHOULD vary.
 *
 * THREE KINDS, AND THE KIND IS THE WHOLE OF THE DIFFERENCE:
 *
 *   `receipt`   — it happened and it is over. Retires itself, needs no acknowledgement, carries at most one way
 *                 back. "3 files deleted."
 *   `condition` — it is TRUE RIGHT NOW. Stays exactly as long as it is true, because it is a fact about the
 *                 session rather than an event in it. "Limited connection to this sandbox."
 *   `question`  — the user owes an answer. Nothing but answering or waving it off retires it: a question that
 *                 timed out is a decision nobody made.
 *
 * TWO WAYS IN, AND THE SPLIT IS DELIBERATE.
 *
 * A receipt is IMPERATIVE (`say`, `warn`): something happened at a moment, there is no state to read, and it is
 * gone before anything could re-derive it. One at a time, newest wins — two stacked receipts is a notification
 * centre, and the second one is always the one the user is looking for.
 *
 * A condition or a question is DECLARED (`hold`): a pure function of state that the store re-reads every tick.
 * This is what makes them impossible to leak and impossible to double-raise. There is no `raise` for them and
 * no `remove`: a held item leaves when its source stops returning it and at no other time, so "is this on
 * screen" and "is this true" cannot drift apart. It is also why the host never deletes one: pressing Dismiss
 * calls the owner's own `dismiss`, the owner records it, the source goes quiet, and the card leaves. A host
 * that spliced it out of a local list would be arguing with the next tick. */

export type NotificationKind = "receipt" | "condition" | "question";

/* Tone picks the glyph and the one colour on the card, nothing else: the box is identical for all five, because
 * a message that changes shape with its severity is five components again. `done`/`problem` are the receipt's
 * pair, kept from the old store — "it worked" and "it didn't", said the same calm way. */
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
    /** The long explanation, behind the card's ⓘ. For the paragraph nobody needs but somebody will want. */
    readonly hint?: string;
    /** The escape hatch: a component rendered under the text, for an item whose content is not two strings. */
    readonly body?: Component;
    /** A card that needs room for its body — the lane widens for it and stays right-aligned. */
    readonly wide?: boolean;
    /** At most two. Three buttons on a floating card is a dialog that forgot to block. */
    readonly actions?: readonly NotificationAction[];
    /** Presence of this puts a ✕ on the card. It is the OWNER's to record, not the host's to fake. */
    readonly dismiss?: () => void;
}

export interface Notification extends NotificationInput {
    readonly id: string;
    readonly tone: NotificationTone;
}

/* THE HELD HALF: id → a getter the store calls on every read. `shallowReactive` because the map's own
 * membership has to be tracked (a source registering must re-run the list) while the getters inside it are
 * plain functions with nothing to make reactive. */
const sources = shallowReactive(new Map<string, () => NotificationInput | undefined>());

/* THE IMPERATIVE HALF: one receipt, or none. A counter rather than a timestamp because two receipts raised in
 * the same millisecond must still be two different objects to the host's watcher, which is what re-arms the
 * dwell for the second one instead of letting it inherit the tail of the first. */
const receipt = ref<Notification | undefined>(undefined);
let raised = 0;

const RECEIPT_ID = `receipt`;

/* ORDER IN THE LANE, and the reason it is this way round rather than by severity.
 *
 * The column is anchored to the BOTTOM of the viewport and grows upward, so its last child is the one in the
 * corner and its first child is the one that moves when the stack changes height. That geometry is what decides
 * the order, not importance:
 *
 * THE RECEIPT RIDES ON TOP, because it is the only thing here that appears and vanishes several times a minute,
 * and from the top of a bottom-anchored column it can do that without moving a single card underneath it. A
 * receipt in the corner would shove every standing card up and down the screen all day, including one the user
 * was reaching for.
 *
 * QUESTIONS TAKE THE CORNER, because the corner is the one position in this lane that never moves and the eye
 * already knows where it is. The thing the user still owes an answer to is the thing that should be findable
 * without reading the stack. */
const TIER: Record<NotificationKind, number> = { receipt: 0, condition: 1, question: 2 };

const held = computed<readonly Notification[]>(() =>
    [...sources]
        .map(([id, read]) => {
            const input = read();
            return input === undefined ? undefined : { ...input, id, tone: input.tone ?? `info` };
        })
        .filter((entry): entry is Notification => entry !== undefined),
);

/** Everything on screen, in lane order. Registration order breaks ties within a tier, which is why the sources
 *  are registered in a deliberate order rather than wherever each composable happened to be imported. */
const notifications = computed<readonly Notification[]>(() =>
    [...(receipt.value === undefined ? [] : [receipt.value]), ...held.value].sort((a, b) => TIER[a.kind] - TIER[b.kind]),
);

/** Declare a condition or a question, as a pure function of state. Returns the stopper; module-scoped sources
 *  never need it, and a component that registers one from inside a `v-if` does. Registering an id twice
 *  replaces it, so a runtime that mounts a second time is idempotent rather than doubled. */
export const hold = (id: string, source: () => NotificationInput | undefined): (() => void) => {
    sources.set(id, source);
    return (): void => {
        sources.delete(id);
    };
};

export const useNotifications = () => {
    /* THE APP SAYING "DONE" WITHOUT ASKING FOR ANYTHING BACK.
     *
     * Before there was a channel for this, success was SILENCE and the only feedback the product owned was
     * alarm — which is why every confirmation worth having had to become a permanent element (a counter, a
     * badge, a strip) or not exist at all. Several did not exist: a file deleted from the tree, a path copied, a
     * token revoked all completed in total quiet, and the only way to learn whether they worked was to go and
     * look.
     *
     * Raising one REPLACES whatever is showing, which is also how the dwell restarts: the host watches this ref,
     * so a second archive re-arms the full window rather than inheriting the tail of the first. */
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

    /* THE THIRD THING THAT CAN HAPPEN: not done, not alarming. A background helper that could not answer, a
     * quick-model job with every connected model spent, belongs in neither of the other two channels. It is not
     * a completion, and it is not a failure the user must act on: nothing is broken, no work was lost, and there
     * is nothing to fix but wait. Left with only those two it went in the silent one, so the gesture did nothing
     * at all and looked like a dead control.
     *
     * Same card, same self-retiring contract, one glyph and one colour apart — because "it didn't work" said
     * calmly is still the same KIND of message as "it worked": something happened, here it is, carry on. A
     * failure the user must ACT on is a `question` (or an in-flow <Notice>), and putting one here would retire
     * it before they finished reading it. */
    const warn = (message: string): void => {
        raised += 1;
        receipt.value = { id: `${RECEIPT_ID}:${raised}`, kind: `receipt`, tone: `problem`, title: message };
    };

    const dismissReceipt = (): void => {
        receipt.value = undefined;
    };

    return { notifications, receipt, say, warn, dismissReceipt, hold };
};
