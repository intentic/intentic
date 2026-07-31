import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* What turns a stream of visitor messages into a CONVERSATION.
 *
 * Without this, every message a visitor sends fires the automation afresh — and a fire opens a new isolated
 * conversation with a new worktree (scheduler.ts mints one per fire), so a five-message support chat became
 * five fleet cards, five worktrees, and five agents each answering with no idea what was said a moment ago.
 * The client-supplied `history` papered over the amnesia and nothing papered over the rest.
 *
 * So a visitor thread is recorded here the moment it is admitted: which sandbox conversation it owns and which
 * provider session to resume. The record is also the ADMISSION mark — a thread that has one has already
 * cleared the anti-bot gate, which is what makes "one check per conversation" survive a daemon restart. */

const RecordSchema = z.object({
    // The sandbox conversation this visitor thread owns — a fleet card, a worktree, a chat tab.
    conversationId: z.string(),
    // The provider session to resume, learned from the previous turn. Absent until one has completed (a first
    // turn has nothing to resume, and a turn that errored before the provider answered leaves none).
    sessionId: z.string().optional(),
    startedAt: z.number(),
    lastAt: z.number(),
    // Messages this thread has sent, for the per-conversation ceiling.
    messages: z.number(),
});
export type WebchatSession = z.infer<typeof RecordSchema>;

const FileSchema = z.record(z.string(), RecordSchema);
type SessionsFile = z.infer<typeof FileSchema>;

// How long a quiet thread keeps its conversation before the next message starts a fresh one. A support chat
// resumed a week later would otherwise reopen a worktree whose branch has long since been landed or reaped.
export const WEBCHAT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Bound the file. Threads are evicted oldest-touched-first, so an active conversation is never the one dropped.
const MAX_SESSIONS = 500;

// One visitor thread, keyed by the automation it belongs to AND the id the widget minted — two Doorbells on one
// site must not collide, and neither must two sites' visitors who happen to mint the same uuid.
const keyOf = (automationId: string, visitorConversationId: string): string => `${automationId}:${visitorConversationId}`;

export interface WebchatSessionsStore {
    // The live record for a thread, or undefined when it has none or its TTL has passed. A stale record reads
    // as absent rather than being deleted here: the caller's own write is what prunes, so a read stays a read.
    readonly get: (automationId: string, visitorConversationId: string, ttlMs: number, now: number) => Promise<WebchatSession | undefined>;
    // Admit a thread: return its existing live record, or create one around a freshly minted conversation id.
    readonly open: (
        automationId: string,
        visitorConversationId: string,
        mintConversationId: () => string,
        ttlMs: number,
        now: number,
    ) => Promise<WebchatSession>;
    // Record what the completed turn taught us — the session to resume next time.
    readonly settle: (automationId: string, visitorConversationId: string, sessionId: string | undefined, now: number) => Promise<void>;
}

// A record still inside its TTL, or undefined. A stale one reads as absent rather than being deleted on read:
// the caller's own write is what prunes, so a read stays a read.
const live = (record: WebchatSession | undefined, ttlMs: number, now: number): WebchatSession | undefined =>
    record !== undefined && now - record.lastAt <= ttlMs ? record : undefined;

export const fileWebchatSessionsStore = (path: string): WebchatSessionsStore => {
    const file = jsonFile<SessionsFile>(path, { parse: (raw) => FileSchema.safeParse(raw).data, fallback: () => ({}) });

    return {
        get: async (automationId, visitorConversationId, ttlMs, now) =>
            live((await file.read())[keyOf(automationId, visitorConversationId)], ttlMs, now),
        open: async (automationId, visitorConversationId, mintConversationId, ttlMs, now) => {
            const key = keyOf(automationId, visitorConversationId);
            const written = await file.update((sessions) => {
                const existing = live(sessions[key], ttlMs, now);
                if (existing !== undefined) {
                    return { ...sessions, [key]: { ...existing, lastAt: now, messages: existing.messages + 1 } };
                }
                const fresh: WebchatSession = { conversationId: mintConversationId(), startedAt: now, lastAt: now, messages: 1 };
                return { ...evictOldest({ ...sessions, [key]: fresh }), [key]: fresh };
            });
            return written[key] as WebchatSession;
        },
        settle: async (automationId, visitorConversationId, sessionId, now) => {
            const key = keyOf(automationId, visitorConversationId);
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
