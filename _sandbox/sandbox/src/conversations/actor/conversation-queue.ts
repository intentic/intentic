import {
    AgentTurnSchema,
    type ConversationQueue,
    mentionPaths,
    MessageVoiceSchema,
    type QueuePause,
    QueuePauseSchema,
    type ResumeRouting,
    SessionOwnerSchema,
    TurnSpeakerSchema,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { opt } from "../../opt.js";

// A conversation's waiting messages as its actor keeps them: each one the whole request it will start or be said into,
// so a restart loses nothing a sender handed over, and the card shows the words alone. Pure: the actor's `decide` applies
// these one event at a time, and every change moves the revision, since two windows edit the same queue.

// The other thing a booked message can wait for besides an instant: another conversation's work, in the workspace
// (turn-resume.ts, releaseBooked). `since` is when the booking was made: a stopped or failed conversation counts only once
// work of its was landed after it.
const AfterLandSchema = z.object({ conversationId: z.string(), since: z.number() });
export type AfterLand = z.infer<typeof AfterLandSchema>;

// The request a queued message makes: the words and who serves the turn they start, as its sender named them.
const QueuedTurnSchema = z.intersection(AgentTurnSchema, z.object({ conversationId: z.string() }));

const QueuedItemSchema = z.object({
    // The message's id, which its request carries too (`messageId`): what a resend, an edit and a removal name.
    id: z.string(),
    voice: MessageVoiceSchema,
    // Who sent it, as the daemon verified them; what the turn it reaches is attributed to.
    actor: z.string().optional(),
    // The same, whole (schemas/speaker.ts): what the row it opens says spoke it.
    speaker: TurnSpeakerSchema.optional(),
    // The verified member who sent it: the owner of a conversation this message opens.
    owner: SessionOwnerSchema.pick({ email: true, name: true }).optional(),
    // The fence its sender works behind, which a conversation this message opens is born inside.
    areas: z.array(z.string()).readonly().optional(),
    // The source of outside words in it; whatever turn it reaches is tainted by it.
    outside: z.string().optional(),
    queuedAt: z.number(),
    // The queue's revision when this message was last written.
    revision: z.number(),
    turn: QueuedTurnSchema,
    // A person's scheduled send carries its own booking: when it goes by itself (ms), or whose landed work it goes
    // after, never both. Each message its own, so booking one never re-times another. Absent on a message that goes as
    // soon as the conversation is free.
    until: z.number().optional(),
    after: AfterLandSchema.optional(),
});
export type QueuedItem = z.infer<typeof QueuedItemSchema>;

// The queue-level `paused`, `until` and `after` are two things. A `stopped` or `refused` pause is a hold on the messages
// that carry no booking: they wait for a press. A `scheduled` pause, with `until` or `after`, is never a hold here: it is
// the soonest of the messages' own bookings, derived on every write (`next`), so an editor older than per-message
// bookings draws when something goes, and an older daemon a rollback lands on holds everything until then rather than
// sending every booked message at its boot.
export const TurnQueueSchema = z.object({
    items: z.array(QueuedItemSchema),
    revision: z.number(),
    paused: QueuePauseSchema.optional(),
    // The soonest booked message's instant (ms), on a `scheduled` queue.
    until: z.number().optional(),
    // Or, when no booked message waits for an instant, the first one's land; only on a `scheduled` queue too.
    after: AfterLandSchema.optional(),
});
export type TurnQueue = z.infer<typeof TurnQueueSchema>;

// What a booked message waits for: an instant, or another conversation's work landing. Exactly one.
export type Booking = { readonly until: number; readonly after?: undefined } | { readonly after: AfterLand; readonly until?: undefined };

// The holds a press lets go: a Stop, or a refusal at the door. Neither touches a booked message.
export type QueueHold = Exclude<QueuePause, "scheduled">;

// The booking one message waits by, if any.
export const bookingOfItem = (item: Pick<QueuedItem, "until" | "after">): Booking | undefined => {
    if (item.until !== undefined) {
        return { until: item.until };
    }
    return item.after === undefined ? undefined : { after: item.after };
};

export const isBooked = (item: Pick<QueuedItem, "until" | "after">): boolean => item.until !== undefined || item.after !== undefined;

/** What goes as soon as the conversation is free and nothing holds it: every message not booked for later. */
export const waitingOf = (queue: Pick<TurnQueue, "items">): readonly QueuedItem[] => queue.items.filter((item) => !isBooked(item));

/** The messages booked for later, each by its own booking. */
export const bookedItemsOf = (queue: Pick<TurnQueue, "items">): readonly QueuedItem[] => queue.items.filter(isBooked);

/** The hold on the unbooked messages, if any: a `scheduled` pause is only the soonest booking, never a hold. */
export const holdOf = (queue: Pick<TurnQueue, "paused">): QueueHold | undefined =>
    queue.paused === "stopped" || queue.paused === "refused" ? queue.paused : undefined;

// The soonest booking among the messages: the earliest instant, or, with none, the first message waiting on a land.
const soonestOf = (items: readonly QueuedItem[]): Booking | undefined => {
    const instants = items.flatMap((item) => (item.until === undefined ? [] : [item.until]));
    if (instants.length > 0) {
        return { until: Math.min(...instants) };
    }
    const after = items.find((item) => item.after !== undefined)?.after;
    return after === undefined ? undefined : { after };
};

// A message with this booking in place of whatever it had; undefined takes its booking off.
const rebooked = (item: QueuedItem, booking: Booking | undefined): QueuedItem => {
    const { until: _until, after: _after, ...rest } = item;
    return { ...rest, ...opt("until", booking?.until), ...opt("after", booking?.after) };
};

export const NO_QUEUE: TurnQueue = { items: [], revision: 0 };

// What an edit or a removal found: done, the message changed since it was read, or it is no longer waiting.
export type QueueChange = "done" | "stale" | "missing";

// The next queue: its revision moved, and its queue-level fields derived from what it now holds. The hold stands only
// while an unbooked message is left for it to hold; otherwise, while anything is booked, the queue reads `scheduled` at
// its soonest booking (the shadow above).
const next = (queue: TurnQueue, items: readonly QueuedItem[], hold: QueueHold | undefined): TurnQueue => {
    const holding = hold !== undefined && items.some((item) => !isBooked(item)) ? hold : undefined;
    const soonest = holding === undefined ? soonestOf(items) : undefined;
    return {
        items: [...items],
        revision: queue.revision + 1,
        ...opt("paused", holding ?? (soonest === undefined ? undefined : "scheduled")),
        ...opt("until", soonest?.until),
        ...opt("after", soonest?.after),
    };
};

// The ids a change names, or every message's when it names none: an older editor names none, and meant the whole queue.
const named = (queue: TurnQueue, ids: readonly string[] | undefined): ReadonlySet<string> => new Set(ids ?? queue.items.map((item) => item.id));

/**
 * Joins the end of the queue; a person's message lets a Stop's or a refusal's hold go, since sending again is them saying
 * so. A booked message is not held, and stays on its time: sending something now says nothing about it.
 */
export const joined = (queue: TurnQueue, item: Omit<QueuedItem, "revision">): TurnQueue => {
    if (queue.items.some((waiting) => waiting.id === item.id)) {
        return queue;
    }
    return next(queue, [...queue.items, rebooked({ ...item, revision: queue.revision + 1 }, undefined)], item.voice === "person" ? undefined : holdOf(queue));
};

/**
 * Joins the end of the queue booked by `booking`: a person's scheduled send, for an instant (a time they chose, a spent
 * allowance's reopen) or for after another conversation's work lands. Its own booking only: every other message keeps
 * whatever it waits for, and a hold on the unbooked ones stands.
 */
export const scheduled = (queue: TurnQueue, item: Omit<QueuedItem, "revision">, booking: Booking): TurnQueue => {
    if (queue.items.some((waiting) => waiting.id === item.id)) {
        return queue;
    }
    return next(queue, [...queue.items, rebooked({ ...item, revision: queue.revision + 1 }, booking)], holdOf(queue));
};

/**
 * Books the messages named by another booking, whatever held them before, or every message when none are named; the
 * rest keep theirs. An empty queue has nothing to book.
 */
export const rescheduled = (queue: TurnQueue, booking: Booking, ids?: readonly string[]): TurnQueue => {
    if (queue.items.length === 0) {
        return queue;
    }
    const these = named(queue, ids);
    return next(
        queue,
        queue.items.map((item) => (these.has(item.id) ? rebooked(item, booking) : item)),
        holdOf(queue),
    );
};

/** Takes out what a turn just delivered. */
export const taken = (queue: TurnQueue, ids: readonly string[]): TurnQueue =>
    next(
        queue,
        queue.items.filter((item) => !ids.includes(item.id)),
        holdOf(queue),
    );

/**
 * Puts back at the head what a refusal handed back, held until somebody says go, since sending it again as it is refuses
 * again. A booked message behind them keeps its time.
 */
export const returned = (queue: TurnQueue, items: readonly Omit<QueuedItem, "revision">[]): TurnQueue => {
    const back = items.filter((item) => !queue.items.some((waiting) => waiting.id === item.id));
    return next(queue, [...back.map((item) => rebooked({ ...item, revision: queue.revision + 1 }, undefined)), ...queue.items], "refused");
};

/**
 * Holds the unbooked messages, for the reason given; nothing unbooked waiting has nothing to hold. A booked message is the
 * person's own appointment, which a stop (the one hold made this way) does not undo: it goes at its time.
 */
export const hold = (queue: TurnQueue, reason: QueueHold): TurnQueue =>
    waitingOf(queue).length === 0 || holdOf(queue) === reason ? queue : next(queue, queue.items, reason);

/**
 * Lets go the hold and the bookings of the messages named, or of every message when none are named: a press on Resume or
 * Send now, or a booking's time come. A due booking lifts a Stop's hold too, so what that held goes along with it.
 */
export const released = (queue: TurnQueue, ids?: readonly string[]): TurnQueue => {
    const these = named(queue, ids);
    if (holdOf(queue) === undefined && !queue.items.some((item) => these.has(item.id) && isBooked(item))) {
        return queue;
    }
    return next(
        queue,
        queue.items.map((item) => (these.has(item.id) && isBooked(item) ? rebooked(item, undefined) : item)),
        undefined,
    );
};

/**
 * Points each person's waiting message the press names (every one, when it names none) at who it names to serve it: the
 * usual answer to a refusal that held them. No model named keeps each message's own, since an unloaded catalog has no
 * pick to send.
 */
export const rerouted = (queue: TurnQueue, routing: ResumeRouting, ids?: readonly string[]): TurnQueue => {
    const these = named(queue, ids);
    const moved = (item: QueuedItem): QueuedItem => {
        if (item.voice !== "person" || !these.has(item.id)) {
            return item;
        }
        const { agent: _agent, harness: _harness, account: _account, model, ...turn } = item.turn;
        const pick = routing.model ?? model;
        const routed = { ...turn, agent: routing.agent, harness: routing.harness, ...opt("account", routing.account), ...opt("model", pick) };
        return { ...item, revision: queue.revision + 1, turn: routed };
    };
    return next(queue, queue.items.map(moved), holdOf(queue));
};

// The one message named, if it still reads as it did at `revision`.
const changing = (queue: TurnQueue, id: string, revision: number): QueueChange | QueuedItem => {
    const item = queue.items.find((waiting) => waiting.id === id);
    if (item === undefined) {
        return "missing";
    }
    return item.revision === revision ? item : "stale";
};

/** Takes one message back out, unless it was reworded since it was read. */
export const removed = (queue: TurnQueue, id: string, revision: number): { readonly queue: TurnQueue; readonly change: QueueChange } => {
    const item = changing(queue, id, revision);
    if (typeof item === "string") {
        return { queue, change: item };
    }
    return {
        queue: next(
            queue,
            queue.items.filter((waiting) => waiting !== item),
            holdOf(queue),
        ),
        change: "done",
    };
};

/** Rewords one message where it stands, unless somebody reworded it since it was read. */
export const edited = (queue: TurnQueue, id: string, revision: number, text: string): { readonly queue: TurnQueue; readonly change: QueueChange } => {
    const item = changing(queue, id, revision);
    if (typeof item === "string") {
        return { queue, change: item };
    }
    // The mentions are read out of the words, so new words carry their own; a chosen file stays chosen.
    const { mentions: _read, ...turn } = item.turn;
    const mentions = mentionPaths(text).filter((path) => !(turn.attachments ?? []).includes(path));
    const rewritten: QueuedItem = { ...item, revision: queue.revision + 1, turn: { ...turn, prompt: text, ...(mentions.length > 0 ? { mentions } : {}) } };
    return {
        queue: next(
            queue,
            queue.items.map((waiting) => (waiting === item ? rewritten : waiting)),
            holdOf(queue),
        ),
        change: "done",
    };
};

/**
 * The queue as every window shows it: the words, their files, whose they are and when each booked one goes, never the
 * request behind them. The queue-level booking is the soonest, for editors that read only that.
 */
export const queueView = (queue: TurnQueue): ConversationQueue => ({
    items: queue.items.map((item) => ({
        id: item.id,
        text: item.turn.prompt,
        ...(item.turn.attachments === undefined || item.turn.attachments.length === 0 ? {} : { attachments: [...item.turn.attachments] }),
        voice: item.voice,
        queuedAt: item.queuedAt,
        revision: item.revision,
        ...opt("until", item.until),
        ...opt("after", item.after?.conversationId),
    })),
    revision: queue.revision,
    ...(queue.paused === undefined ? {} : { paused: queue.paused }),
    ...opt("until", queue.paused === "scheduled" ? queue.until : undefined),
    ...opt("after", queue.paused === "scheduled" ? queue.after?.conversationId : undefined),
});
