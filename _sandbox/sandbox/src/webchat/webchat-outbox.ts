import type { AgentOrigin } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { TurnStream } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { threadKey } from "../sessions/thread-sessions.js";
import { jsonFile } from "../store/json-file.js";
import { WEBCHAT_PROVIDER } from "./webchat-config.js";

// Replies a Visitor chat visitor has not received yet. The widget's SSE is open only for the turn that answers live; an
// approval-gated guest closes it on a "pending" notice, and a human writing as the agent hours later has no stream at
// all. Both land here, and the widget's poll drains them on the visitor's next page load.
//
// Per thread, not per conversation: the key is the thread key (provider:automation:channel), so a reply survives the
// thread session expiring and still reaches the same browser, which keeps its conversation id until the visitor resets.

const EntrySchema = z.object({
    // Per-thread, strictly increasing, and never reused after a trim: a stale cursor can only under-deliver, never
    // replay.
    seq: z.number(),
    at: z.number(),
    text: z.string(),
});
export type OutboxEntry = z.infer<typeof EntrySchema>;

const ThreadSchema = z.object({
    lastAt: z.number(),
    // Next seq to hand out; kept past a trim so seqs stay unique for the life of the thread.
    nextSeq: z.number(),
    entries: z.array(EntrySchema),
});

const FileSchema = z.record(z.string(), ThreadSchema);
type OutboxFile = z.infer<typeof FileSchema>;

// How long an undelivered reply waits. Deliberately far longer than a thread session's TTL: the session decides
// whether the agent remembers the visitor, this decides whether a human's answer ever arrives.
const OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Newest kept per thread. A visitor who never returns cannot grow one thread without bound.
const MAX_PER_THREAD = 50;

// Threads beyond this are evicted least-recently-written first, so a live conversation is never the one dropped.
const MAX_THREADS = 500;

// One reply is one message in the widget; longer than this is a wall of text nobody reads in a 360px panel.
const TEXT_MAX = 8_000;

export interface WebchatOutbox {
    // Queues one reply and returns its seq. Empty text is not queued, and answers the thread's current seq instead.
    readonly append: (key: string, text: string, now: number) => Promise<number>;
    // Replies after `afterSeq`, oldest first, plus the cursor to send next time. A thread past its TTL reads as empty.
    readonly since: (key: string, afterSeq: number, now: number) => Promise<{ replies: OutboxEntry[]; cursor: number }>;
}

// Staleness reads as absence, matching thread-sessions; only the next write actually prunes.
const live = (thread: z.infer<typeof ThreadSchema> | undefined, now: number): z.infer<typeof ThreadSchema> | undefined =>
    thread !== undefined && now - thread.lastAt <= OUTBOX_TTL_MS ? thread : undefined;

export const fileWebchatOutbox = (path: string): WebchatOutbox => {
    const file = jsonFile<OutboxFile>(path, { parse: (raw) => FileSchema.safeParse(raw).data, fallback: () => ({}) });

    return {
        append: async (key, text, now) => {
            const trimmed = text.trim().slice(0, TEXT_MAX);
            if (trimmed === "") {
                return (await file.read())[key]?.nextSeq ?? 0;
            }
            const written = await file.update((all) => {
                const existing = live(all[key], now) ?? { lastAt: now, nextSeq: 1, entries: [] };
                const entry: OutboxEntry = { seq: existing.nextSeq, at: now, text: trimmed };
                const thread = {
                    lastAt: now,
                    nextSeq: existing.nextSeq + 1,
                    entries: [...existing.entries, entry].slice(-MAX_PER_THREAD),
                };
                return { ...evict(prune({ ...all, [key]: thread }, now)), [key]: thread };
            });
            // `nextSeq` advanced past the entry just written, so the entry's own seq is one behind it.
            return (written[key]?.nextSeq ?? 1) - 1;
        },
        since: async (key, afterSeq, now) => {
            const thread = live((await file.read())[key], now);
            if (thread === undefined) {
                return { replies: [], cursor: afterSeq };
            }
            const replies = thread.entries.filter((entry) => entry.seq > afterSeq);
            // Cursor is the thread's high-water mark, not the last reply returned: a trimmed-away seq must not be
            // waited for forever.
            return { replies, cursor: Math.max(afterSeq, thread.nextSeq - 1) };
        },
    };
};

// Drops threads past their TTL; returns the same object when nothing is stale.
const prune = (all: OutboxFile, now: number): OutboxFile => {
    const kept = Object.entries(all).filter(([, thread]) => live(thread, now) !== undefined);
    return kept.length === Object.keys(all).length ? all : Object.fromEntries(kept);
};

// Drops the least recently written threads once over the cap; returns the same object when nothing needs dropping.
const evict = (all: OutboxFile): OutboxFile => {
    const entries = Object.entries(all);
    if (entries.length <= MAX_THREADS) {
        return all;
    }
    return Object.fromEntries(entries.toSorted(([, a], [, b]) => b.lastAt - a.lastAt).slice(0, MAX_THREADS));
};

// The thread an origin names, or undefined when it is not a Visitor chat one. The provider check lives here rather than
// at the call sites, so nothing outside this module has to know which providers have an outbox.
export const outboxKeyOf = (origin: AgentOrigin | undefined): string | undefined =>
    origin === undefined || origin.provider !== WEBCHAT_PROVIDER || origin.channelId === undefined
        ? undefined
        : threadKey(origin.provider, origin.automationId, origin.channelId);

export interface OutboxSink {
    readonly stream: TurnStream;
    // Resolves once the queued reply is actually on disk. `TurnStream.end` returns void, so without this the write is
    // still in flight when the turn returns: a poll landing in that window sees nothing, and a restart loses the answer.
    readonly settled: () => Promise<void>;
}

// A TurnStream that queues the whole answer instead of streaming it: what a wake with no live visitor writes into.
// Attaching one also earns the run its STREAM_NOTE, which is what stops the model trying to send the reply itself —
// correct here, since a Visitor chat gives it no tool that could.
export const outboxTurnStream = (services: Services, key: string): OutboxSink => {
    let text = "";
    let write: Promise<void> = Promise.resolve();
    return {
        stream: {
            delta: (chunk) => {
                text += chunk;
            },
            // Deliberately silent: a run that produced no answer leaves the thread for a human, rather than handing the
            // visitor the owner's own facts about why it failed.
            failed: () => undefined,
            end: () => {
                write = services.webchatOutbox
                    .append(key, text, Date.now())
                    .then(() => undefined)
                    .catch((error: unknown) => services.logger.warn({ err: error }, "web-chat outbox append failed"));
            },
        },
        settled: () => write,
    };
};

// The sink an approved wake answers into, or undefined when its origin is not a Visitor chat. Called by the scheduler's
// held-wake release, which has no other way to know a visitor is waiting.
export const outboxStreamFor = (services: Services, origin: AgentOrigin | undefined): OutboxSink | undefined => {
    const key = outboxKeyOf(origin);
    return key === undefined ? undefined : outboxTurnStream(services, key);
};
