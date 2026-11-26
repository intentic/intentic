import { join } from "node:path";
import type { WebchatPending } from "@intentic/sandbox-contract/schemas/automations";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { z } from "zod";
import { WEBCHAT_PROVIDER } from "./chats.js";
import { type JsonFile, jsonFile } from "./json-file.js";

// REPLIES A VISITOR HAS NOT RECEIVED YET. The widget's stream is open only for the turn that answers live; a wake held
// for a person closes it on a "pending" notice, and a person writing as the agent hours later has no stream at all. Both
// reach this extension's gateway as a channel's reply (/deliver) and land here, and the widget's poll drains them on the
// visitor's next look. Kept where the daemon kept it until 2026-11-26, `.intentic/records/webchat-outbox.json`, in the
// same shape (one record per thread, keyed `webchat:<automation>:<conversation>`), so what a sandbox still owed its
// visitors then reaches them now. The gateway is its one writer; the backend only reads it.

export const OUTBOX_FILE = `${STATE_GROUP_DIR.records}/webchat-outbox.json`;

const EntrySchema = z.object({
    // Per thread, strictly increasing, never reused after a trim: a stale cursor can only under-deliver, never replay.
    seq: z.number(),
    at: z.number(),
    text: z.string(),
});

const ThreadSchema = z.object({
    lastAt: z.number(),
    // The next seq to hand out; kept past a trim so seqs stay unique for the life of the thread.
    nextSeq: z.number(),
    entries: z.array(EntrySchema),
});
type OutboxThread = z.infer<typeof ThreadSchema>;

const OutboxFileSchema = z.record(z.string(), ThreadSchema);
type OutboxFile = z.infer<typeof OutboxFileSchema>;

// How long an undelivered reply waits: far longer than a conversation lasts, since this decides whether a person's
// answer ever arrives.
const OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Newest kept per thread, so a visitor who never returns cannot grow one thread without bound.
const MAX_PER_THREAD = 50;
// Threads beyond this are evicted least recently written first, so a live conversation is never the one dropped.
const MAX_THREADS = 500;
// One reply is one message in a 360px panel; longer is a wall of text nobody reads.
const TEXT_MAX = 8_000;

/** The outbox's key for a visitor's thread on one chat, the daemon's thread key. */
export const outboxKeyOf = (automationId: string, conversationId: string): string => `${WEBCHAT_PROVIDER}:${automationId}:${conversationId}`;

export interface Outbox {
    // Queues one reply and answers its seq; empty text is not queued and answers the thread's current seq.
    readonly append: (key: string, text: string, now: number) => Promise<number>;
    // Replies after `afterSeq`, oldest first, and the cursor to send next time; a thread past its time reads as empty.
    readonly since: (key: string, afterSeq: number, now: number) => Promise<WebchatPending>;
    // The chat a visitor's conversation already has replies waiting under, if any.
    readonly chatOf: (conversationId: string) => Promise<string | undefined>;
}

const live = (thread: OutboxThread | undefined, now: number): OutboxThread | undefined => (thread !== undefined && now - thread.lastAt <= OUTBOX_TTL_MS ? thread : undefined);

const keptWithin = (all: OutboxFile, now: number): OutboxFile => {
    const fresh = Object.entries(all).filter(([, thread]) => live(thread, now) !== undefined);
    const kept = fresh.length <= MAX_THREADS ? fresh : fresh.toSorted(([, a], [, b]) => b.lastAt - a.lastAt).slice(0, MAX_THREADS);
    return kept.length === Object.keys(all).length ? all : Object.fromEntries(kept);
};

export const fileOutbox = (file: JsonFile<OutboxFile>): Outbox => ({
    append: async (key, text, now) => {
        const trimmed = text.trim().slice(0, TEXT_MAX);
        if (trimmed === ``) {
            return (await file.read())[key]?.nextSeq ?? 0;
        }
        const written = await file.update((all) => {
            const existing = live(all[key], now) ?? { lastAt: now, nextSeq: 1, entries: [] };
            const thread = { lastAt: now, nextSeq: existing.nextSeq + 1, entries: [...existing.entries, { seq: existing.nextSeq, at: now, text: trimmed }].slice(-MAX_PER_THREAD) };
            return { ...keptWithin({ ...all, [key]: thread }, now), [key]: thread };
        });
        // `nextSeq` moved past the entry just written, so its own seq is one behind.
        return (written[key]?.nextSeq ?? 1) - 1;
    },
    since: async (key, afterSeq, now) => {
        const thread = live((await file.read())[key], now);
        if (thread === undefined) {
            return { replies: [], cursor: afterSeq };
        }
        // The cursor is the thread's high-water mark, not the last reply returned: a trimmed-away seq is never waited for.
        return { replies: thread.entries.filter((entry) => entry.seq > afterSeq), cursor: Math.max(afterSeq, thread.nextSeq - 1) };
    },
    chatOf: async (conversationId) => {
        const prefix = `${WEBCHAT_PROVIDER}:`;
        const suffix = `:${conversationId}`;
        const key = Object.keys(await file.read()).find((each) => each.startsWith(prefix) && each.endsWith(suffix) && each.length > prefix.length + suffix.length);
        return key?.slice(prefix.length, -suffix.length);
    },
});

/** The outbox under the workspace root `root`. */
export const workspaceOutbox = (root: string): Outbox => fileOutbox(jsonFile(join(root, OUTBOX_FILE), OutboxFileSchema, (): OutboxFile => ({})));
