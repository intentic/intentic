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
});
export type QueuedItem = z.infer<typeof QueuedItemSchema>;

export const TurnQueueSchema = z.object({
    items: z.array(QueuedItemSchema),
    revision: z.number(),
    paused: QueuePauseSchema.optional(),
});
export type TurnQueue = z.infer<typeof TurnQueueSchema>;

export const NO_QUEUE: TurnQueue = { items: [], revision: 0 };

// What an edit or a removal found: done, the message changed since it was read, or it is no longer waiting.
export type QueueChange = "done" | "stale" | "missing";

// The next queue: its revision moved, and no hold left over a queue with nothing in it to hold.
const next = (queue: TurnQueue, items: readonly QueuedItem[], paused: QueuePause | undefined): TurnQueue => ({
    items: [...items],
    revision: queue.revision + 1,
    ...(paused === undefined || items.length === 0 ? {} : { paused }),
});

/** Joins the end of the queue; a person's message lets a held queue go, since sending again is them saying so. */
export const joined = (queue: TurnQueue, item: Omit<QueuedItem, "revision">): TurnQueue => {
    if (queue.items.some((waiting) => waiting.id === item.id)) {
        return queue;
    }
    return next(queue, [...queue.items, { ...item, revision: queue.revision + 1 }], item.voice === "person" ? undefined : queue.paused);
};

/** Takes out what a turn just delivered. */
export const taken = (queue: TurnQueue, ids: readonly string[]): TurnQueue =>
    next(
        queue,
        queue.items.filter((item) => !ids.includes(item.id)),
        queue.paused,
    );

/** Puts back at the head what a refusal handed back, held until somebody says go, since sending it again as it is refuses again. */
export const returned = (queue: TurnQueue, items: readonly Omit<QueuedItem, "revision">[]): TurnQueue => {
    const back = items.filter((item) => !queue.items.some((waiting) => waiting.id === item.id));
    return next(queue, [...back.map((item) => ({ ...item, revision: queue.revision + 1 })), ...queue.items], "refused");
};

/** Holds what waits, for the reason given; an empty queue has nothing to hold. */
export const hold = (queue: TurnQueue, reason: QueuePause): TurnQueue =>
    queue.items.length === 0 || queue.paused === reason ? queue : next(queue, queue.items, reason);

/** Lets a held queue go. */
export const released = (queue: TurnQueue): TurnQueue => (queue.paused === undefined ? queue : next(queue, queue.items, undefined));

/**
 * Points every person's waiting message at who the press names to serve it: the usual answer to a refusal that held them.
 * No model named keeps each message's own, since an unloaded catalog has no pick to send.
 */
export const rerouted = (queue: TurnQueue, routing: ResumeRouting): TurnQueue => {
    const moved = (item: QueuedItem): QueuedItem => {
        if (item.voice !== "person") {
            return item;
        }
        const { agent: _agent, harness: _harness, account: _account, model, ...turn } = item.turn;
        const pick = routing.model ?? model;
        const routed = { ...turn, agent: routing.agent, harness: routing.harness, ...opt("account", routing.account), ...opt("model", pick) };
        return { ...item, revision: queue.revision + 1, turn: routed };
    };
    return next(queue, queue.items.map(moved), queue.paused);
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
            queue.paused,
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
            queue.paused,
        ),
        change: "done",
    };
};

/** The queue as every window shows it: the words, their files and whose they are, never the request behind them. */
export const queueView = (queue: TurnQueue): ConversationQueue => ({
    items: queue.items.map((item) => ({
        id: item.id,
        text: item.turn.prompt,
        ...(item.turn.attachments === undefined || item.turn.attachments.length === 0 ? {} : { attachments: [...item.turn.attachments] }),
        voice: item.voice,
        queuedAt: item.queuedAt,
        revision: item.revision,
    })),
    revision: queue.revision,
    ...(queue.paused === undefined ? {} : { paused: queue.paused }),
});
