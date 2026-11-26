import type { WebchatConfig } from "@intentic/sandbox-contract/schemas/automations";
import { z } from "zod";

// A VISITOR'S THREAD: the widget's conversation id on one chat, as this backend remembers it between messages, in its own
// state directory. Until 2026-11-26 the daemon's thread sessions held it. A thread is on one generation at a time, and
// each generation is one conversation in the sandbox (the listener message's `thread`): a thread quiet past its chat's
// time to live starts the next generation, so the agent meets the visitor afresh, with the transcript the widget sends as
// its history, and the visitor clears the bot check again. Within a generation the record is the proof the check was
// passed, and it counts the messages the chat's per-conversation ceiling holds.

// How long a quiet thread keeps its conversation when the chat names no time of its own.
export const THREAD_TTL_DEFAULT_MS = 24 * 60 * 60 * 1000;
// The longest a thread keeps its conversation, whatever the chat says: the daemon's listener lets a thread's session go
// after a week of quiet, so a longer one here would resume a conversation the agent no longer has, without the history.
export const THREAD_TTL_MAX_MS = 7 * 24 * 60 * 60 * 1000;
// Threads kept at once; past it the least recently spoken go first.
const THREADS_MAX = 2_000;

const ThreadSchema = z.object({
    generation: z.number().int().min(0),
    lastAt: z.number(),
    messages: z.number().int().min(0),
});
export type ThreadRecord = z.infer<typeof ThreadSchema>;

export const ThreadsFileSchema = z.record(z.string(), ThreadSchema);
export type ThreadsFile = z.infer<typeof ThreadsFileSchema>;

/** Where the threads are kept: `api.document`'s handle, or a test's own. */
export interface ThreadsDocument {
    read(): Promise<ThreadsFile>;
    update(change: (current: ThreadsFile) => ThreadsFile): Promise<ThreadsFile>;
}

/** How long a quiet thread of this chat keeps its conversation. */
export const threadTtlOf = (config: WebchatConfig): number => Math.min((config.sessionTtlMinutes ?? 0) * 60_000 || THREAD_TTL_DEFAULT_MS, THREAD_TTL_MAX_MS);

// What a message finds of its thread: whether its generation is still live, and which one it speaks on.
export interface ThreadState {
    readonly live: boolean;
    readonly generation: number;
    readonly messages: number;
}

export interface Threads {
    /** The thread as a message now finds it: its live generation, or the one it would start. Nothing is written. */
    readonly state: (key: string, ttlMs: number, now: number) => Promise<ThreadState>;
    /** One message admitted on `generation`: counted, and the thread kept alive from now. */
    readonly note: (key: string, generation: number, now: number) => Promise<void>;
}

const liveIn = (thread: ThreadRecord | undefined, ttlMs: number, now: number): boolean => thread !== undefined && now - thread.lastAt <= ttlMs;

// Drops what no chat could resume any more, then the least recently spoken past the cap; the same object when neither.
const pruned = (all: ThreadsFile, now: number): ThreadsFile => {
    const entries = Object.entries(all).filter(([, thread]) => now - thread.lastAt <= THREAD_TTL_MAX_MS);
    const kept = entries.length <= THREADS_MAX ? entries : entries.toSorted(([, a], [, b]) => b.lastAt - a.lastAt).slice(0, THREADS_MAX);
    return kept.length === Object.keys(all).length ? all : Object.fromEntries(kept);
};

/** The key a thread is kept under: its chat and the widget's conversation id. */
export const threadKeyOf = (automationId: string, conversationId: string): string => `${automationId}:${conversationId}`;

export const documentThreads = (document: ThreadsDocument): Threads => ({
    state: async (key, ttlMs, now) => {
        const thread = (await document.read())[key];
        if (liveIn(thread, ttlMs, now) && thread !== undefined) {
            return { live: true, generation: thread.generation, messages: thread.messages };
        }
        return { live: false, generation: thread === undefined ? 0 : thread.generation + 1, messages: 0 };
    },
    note: async (key, generation, now) => {
        await document.update((all) => {
            const thread = all[key];
            const messages = thread?.generation === generation ? thread.messages + 1 : 1;
            return { ...pruned(all, now), [key]: { generation, lastAt: now, messages } };
        });
    },
});
