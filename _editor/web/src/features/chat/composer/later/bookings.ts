import type { ConversationQueue, QueuedMessage, QueuePause } from "@intentic/sandbox-contract";
import { laterOfQueue, type SendLater } from "./sendLater";

// Which waiting message goes when, read off the daemon's queue. A sandbox from 2026-10 on books each message on its own
// (`until` or `after` on the message), and its queue-level `scheduled` with `until` or `after` is only the soonest of
// those, kept for windows older than that. A sandbox from before books the whole queue at once: no message carries a
// booking, and the queue-level one is every message's. Which of the two a queue came from is read off the queue itself,
// so a window never asks a sandbox to act on one message when it would act on all of them. Pure and value-typed.

type QueueRead = Pick<ConversationQueue, "items" | "paused" | "until" | "after">;

// The hold a press lets go: a Stop, or a refusal at the door.
type QueueHold = Exclude<QueuePause, "scheduled">;

const carriesBooking = (item: Pick<QueuedMessage, "until" | "after">): boolean => item.until !== undefined || item.after !== undefined;

/** Whether the sandbox books each message on its own: some message carries its own booking. */
export const perMessage = (queue: Pick<ConversationQueue, "items"> | undefined): boolean => (queue?.items ?? []).some(carriesBooking);

/**
 * When one waiting message goes by itself: its own booking, or, from a sandbox that books the whole queue, the queue's.
 * Undefined for a message that goes as soon as nothing holds it.
 */
export const bookingOfMessage = (queue: QueueRead | undefined, item: Pick<QueuedMessage, "until" | "after">): SendLater | undefined => {
    if (item.after !== undefined) {
        return { kind: `after`, conversationId: item.after };
    }
    if (item.until !== undefined) {
        return { kind: `at`, at: item.until };
    }
    return perMessage(queue) ? undefined : laterOfQueue(queue);
};

/**
 * Why the messages with no booking of their own wait for a press: a Stop or a refusal. `scheduled` only from a sandbox
 * that books the whole queue, where it does hold every message; from one that books each message it is the soonest
 * booking, and holds nothing.
 */
export const holdOfQueue = (queue: QueueRead | undefined): QueuePause | undefined =>
    queue?.paused === `scheduled` && perMessage(queue) ? undefined : queue?.paused;

/** The waiting messages no booking holds back: what goes as soon as the conversation is free, or a press lets it. */
export const unbookedOf = (queue: QueueRead | undefined): readonly QueuedMessage[] =>
    (queue?.items ?? []).filter((item) => bookingOfMessage(queue, item) === undefined);

/** Consecutive booked messages that go together: one booking, the messages it holds, and their ids. */
export interface BookedGroup {
    readonly booking: SendLater;
    readonly messages: readonly QueuedMessage[];
    readonly ids: readonly string[];
}

const sameLater = (a: SendLater, b: SendLater): boolean =>
    a.kind === `at` ? b.kind === `at` && a.at === b.at : b.kind === `after` && a.conversationId === b.conversationId;

/**
 * The booked messages, in the queue's order, gathered where neighbours share one booking: what one line, one Change and
 * one Send now act on. A queue booked as a whole by an older sandbox is one group.
 */
export const bookedGroups = (queue: QueueRead | undefined): readonly BookedGroup[] => {
    const groups: { booking: SendLater; messages: QueuedMessage[] }[] = [];
    let joining = false;
    for (const item of queue?.items ?? []) {
        const booking = bookingOfMessage(queue, item);
        const last = groups.at(-1);
        if (booking === undefined) {
            joining = false;
        } else if (joining && last !== undefined && sameLater(last.booking, booking)) {
            last.messages.push(item);
        } else {
            groups.push({ booking, messages: [item] });
            joining = true;
        }
    }
    return groups.map(({ booking, messages }) => ({ booking, messages, ids: messages.map((message) => message.id) }));
};

/**
 * A queue's own fields as the sandbox derives them from its messages (conversation-queue.ts, `next`): the hold while a
 * message it can hold is left, otherwise `scheduled` at the soonest booking (the earliest time, or the first agent waited
 * for), otherwise nothing. What a window writes when it mirrors a change before the sandbox's own queue comes back.
 */
export const queueFromMessages = (items: readonly QueuedMessage[], revision: number, hold: QueueHold | undefined): ConversationQueue => {
    if (hold !== undefined && items.some((item) => !carriesBooking(item))) {
        return { items: [...items], revision, paused: hold };
    }
    const instants = items.flatMap((item) => (item.until === undefined ? [] : [item.until]));
    if (instants.length > 0) {
        return { items: [...items], revision, paused: `scheduled`, until: Math.min(...instants) };
    }
    const after = items.find((item) => item.after !== undefined)?.after;
    return after === undefined ? { items: [...items], revision } : { items: [...items], revision, paused: `scheduled`, after };
};
