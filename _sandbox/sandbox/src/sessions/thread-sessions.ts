import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* What turns a stream of inbound messages into a CONVERSATION.
 *
 * Without this, every message fires its automation afresh, and a fire opens a new isolated conversation with a
 * new worktree (scheduler.ts mints one per fire), so five messages became five fleet cards, five worktrees, and
 * five agents each answering with no idea what was said a moment ago. The Front Desk hit it first (a support chat
 * is obviously one thread), but a Discord or Slack channel is the same shape: tagging the bot three times in
 * #eng is one conversation, not three strangers.
 *
 * So a thread is recorded here the moment it is admitted: which sandbox conversation it owns and which provider
 * session to resume. The record is also the ADMISSION mark for the Front Desk, a thread that has one has already
 * cleared the anti-bot gate, which is what makes "one check per conversation" survive a daemon restart.
 *
 * A thread ENDS by going quiet: past its TTL the record reads as absent, so the next message starts a fresh
 * conversation rather than resuming a session whose subject has long since changed. */

const RecordSchema = z.object({
    // The sandbox conversation this thread owns, a fleet card, a worktree, a chat tab.
    conversationId: z.string(),
    // The provider session to resume, learned from the previous turn. Absent until one has completed (a first
    // turn has nothing to resume, and a turn that errored before the provider answered leaves none).
    sessionId: z.string().optional(),
    startedAt: z.number(),
    lastAt: z.number(),
    // Messages this thread has sent, for the Front Desk's per-conversation ceiling.
    messages: z.number(),
});
export type ThreadSession = z.infer<typeof RecordSchema>;

const FileSchema = z.record(z.string(), RecordSchema);
type SessionsFile = z.infer<typeof FileSchema>;

// How long a quiet Front Desk thread keeps its conversation. A support chat resumed a week later would otherwise
// reopen a worktree whose branch has long since been landed or reaped. Overridable per Front Desk
// (WebchatConfig.sessionTtlMinutes), a visitor comes back to the same tab, so hours are cheap here.
export const WEBCHAT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// How long a quiet CHANNEL keeps its conversation, the Discord/Slack side. Shorter than the Front Desk's on
// purpose: a channel is a room many topics pass through, and resuming this morning's CI thread for this
// afternoon's unrelated question is worse than starting over.
// ponytail: 2h tuned for "one working session"; raise if real channels lose their thread over lunch.
export const CHANNEL_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// Bound the file. Threads are evicted oldest-touched-first, so an active conversation is never the one dropped.
const MAX_SESSIONS = 500;

// One thread. Namespaced by provider so two sources can't collide on a channel id, and by automation so two
// Front Desks on one site, or two automations watching one channel, each keep their own conversation.
export const threadKey = (provider: string, automationId: string, channelId: string): string => `${provider}:${automationId}:${channelId}`;

export interface ThreadSessionsStore {
    // The live record for a thread, or undefined when it has none or its TTL has passed. A stale record reads
    // as absent rather than being deleted here: the caller's own write is what prunes, so a read stays a read.
    readonly get: (key: string, ttlMs: number, now: number) => Promise<ThreadSession | undefined>;
    // Admit a thread: return its existing live record, or create one around a freshly minted conversation id.
    readonly open: (key: string, mintConversationId: () => string, ttlMs: number, now: number) => Promise<ThreadSession>;
    // Record what the completed turn taught us, the session to resume next time.
    readonly settle: (key: string, sessionId: string | undefined, now: number) => Promise<void>;
}

// A record still inside its TTL, or undefined. A stale one reads as absent rather than being deleted on read:
// the caller's own write is what prunes, so a read stays a read.
const live = (record: ThreadSession | undefined, ttlMs: number, now: number): ThreadSession | undefined =>
    record !== undefined && now - record.lastAt <= ttlMs ? record : undefined;

export const fileThreadSessionsStore = (path: string): ThreadSessionsStore => {
    const file = jsonFile<SessionsFile>(path, { parse: (raw) => FileSchema.safeParse(raw).data, fallback: () => ({}) });

    return {
        get: async (key, ttlMs, now) => live((await file.read())[key], ttlMs, now),
        open: async (key, mintConversationId, ttlMs, now) => {
            const written = await file.update((sessions) => {
                const existing = live(sessions[key], ttlMs, now);
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

// Drop the least recently touched threads once the file is over the cap. Returns the same object when nothing
// needs dropping, so the common path costs no copy.
const evictOldest = (sessions: SessionsFile): SessionsFile => {
    const entries = Object.entries(sessions);
    if (entries.length <= MAX_SESSIONS) {
        return sessions;
    }
    return Object.fromEntries(entries.toSorted(([, a], [, b]) => b.lastAt - a.lastAt).slice(0, MAX_SESSIONS));
};
