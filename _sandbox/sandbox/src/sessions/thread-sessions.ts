import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

// Ties a stream of inbound messages (a support chat, a tagged bot) to one conversation and provider session, so repeats
// don't each spawn a fresh isolated worktree. The record also marks a thread past the anti-bot gate, surviving a daemon
// restart. A thread ends by going quiet or by its conversation being archived: the record reads as absent either way.

const RecordSchema = z.object({
    // The sandbox conversation this thread owns, a fleet card, a worktree, a chat tab.
    conversationId: z.string(),
    // The provider session to resume; absent until a turn completes (none yet, or one errored before answering).
    sessionId: z.string().optional(),
    startedAt: z.number(),
    lastAt: z.number(),
    // Messages this thread has sent, for the Visitor chat's per-conversation ceiling.
    messages: z.number(),
});
export type ThreadSession = z.infer<typeof RecordSchema>;

const FileSchema = z.record(z.string(), RecordSchema);
type SessionsFile = z.infer<typeof FileSchema>;

// How long a quiet Visitor chat thread keeps its conversation; overridable via WebchatConfig.sessionTtlMinutes.
export const WEBCHAT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Shorter than the Visitor chat's TTL: a channel carries many unrelated topics, not one visitor's thread.
export const CHANNEL_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// Bound the file. Threads are evicted oldest-touched-first, so an active conversation is never the one dropped.
const MAX_SESSIONS = 500;

// One thread's key: namespaced by provider (no channel-id collisions), by automation (independent conversations per
// automation), and by the persona the sender's lane resolved to, so two people a channel answers as different agents
// never share a conversation or a session (automations/senders.ts). No persona is the bare key.
export const threadKey = (provider: string, automationId: string, channelId: string, persona?: string): string =>
    persona === undefined ? `${provider}:${automationId}:${channelId}` : `${provider}:${automationId}:${channelId}:${persona}`;

export interface ThreadSessionsStore {
    // The live record, or undefined if none or past TTL; only the caller's write prunes a stale one.
    readonly get: (key: string, ttlMs: number, now: number) => Promise<ThreadSession | undefined>;
    // Admit a thread: return its existing live record, or create one around a freshly minted conversation id.
    readonly open: (key: string, mintConversationId: () => string, ttlMs: number, now: number) => Promise<ThreadSession>;
    // Record what the completed turn taught us, the session to resume next time.
    readonly settle: (key: string, sessionId: string | undefined, now: number) => Promise<void>;
}

// Whether a conversation is off the board; only a person reopens one, so no inbound message may resume it.
export type ArchivedConversation = (conversationId: string) => boolean;

// A record still inside its TTL whose conversation is not archived, or undefined; an ended thread reads as absence and
// is never deleted here.
export const liveThread = (record: ThreadSession | undefined, ttlMs: number, now: number, archived: ArchivedConversation): ThreadSession | undefined =>
    record !== undefined && now - record.lastAt <= ttlMs && !archived(record.conversationId) ? record : undefined;

export const fileThreadSessionsStore = (path: string, archived: ArchivedConversation): ThreadSessionsStore => {
    const file = jsonFile<SessionsFile>(path, { parse: (raw) => FileSchema.safeParse(raw).data, fallback: () => ({}) });

    return {
        get: async (key, ttlMs, now) => liveThread((await file.read())[key], ttlMs, now, archived),
        open: async (key, mintConversationId, ttlMs, now) => {
            const written = await file.update((sessions) => {
                const existing = liveThread(sessions[key], ttlMs, now, archived);
                if (existing !== undefined) {
                    return { ...sessions, [key]: { ...existing, lastAt: now, messages: existing.messages + 1 } };
                }
                const fresh: ThreadSession = { conversationId: mintConversationId(), startedAt: now, lastAt: now, messages: 1 };
                return { ...evictOldest({ ...sessions, [key]: fresh }), [key]: fresh };
            });
            return written[key] as ThreadSession;
        },
        settle: async (key, sessionId, now) => {
            await file.update((sessions) => {
                const existing = sessions[key];
                if (existing === undefined) {
                    return sessions;
                }
                return { ...sessions, [key]: { ...existing, lastAt: now, ...(sessionId !== undefined ? { sessionId } : {}) } };
            });
        },
    };
};

// Drops the least recently touched threads once over the cap; returns the same object when nothing needs dropping.
const evictOldest = (sessions: SessionsFile): SessionsFile => {
    const entries = Object.entries(sessions);
    if (entries.length <= MAX_SESSIONS) {
        return sessions;
    }
    return Object.fromEntries(entries.toSorted(([, a], [, b]) => b.lastAt - a.lastAt).slice(0, MAX_SESSIONS));
};
