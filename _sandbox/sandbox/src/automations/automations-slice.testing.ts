import { type ArchivedConversation, liveThread, type ThreadSession, type ThreadSessionsStore } from "../sessions/thread-sessions.js";
import type { AutomationsSlice } from "./automations-slice.js";
import type { AutomationRecord, AutomationsStore } from "./automations-store.js";

// The automations slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

// An in-memory automations store so the fire route is testable without the fs.
export const memoryAutomationsStore = (initial: AutomationRecord[] = []): AutomationsStore => {
    let automations = [...initial];
    return {
        list: async () => automations,
        get: async (id) => automations.find((automation) => automation.id === id),
        upsert: async (automation) => {
            const runs = automations.find((existing) => existing.id === automation.id)?.runs ?? [];
            automations = [...automations.filter((existing) => existing.id !== automation.id), { ...automation, runs }];
        },
        setEnabled: async (id, enabled) => {
            const existing = automations.find((automation) => automation.id === id);
            if (existing === undefined) {
                return false;
            }
            existing.enabled = enabled;
            return true;
        },
        remove: async (id) => {
            const next = automations.filter((automation) => automation.id !== id);
            const existed = next.length !== automations.length;
            automations = next;
            return existed;
        },
        recordRun: async (id, run) => {
            const record = automations.find((automation) => automation.id === id);
            if (record !== undefined) {
                record.runs = [run, ...record.runs];
            }
        },
    };
};

// In-memory thread-session store, so routes turning an inbound message into a conversation are testable without the fs.
// Honours a thread's end, quiet or archived: starting over is behaviour, not bookkeeping.
export const memoryThreadSessionsStore = (archived: ArchivedConversation): ThreadSessionsStore => {
    const sessions = new Map<string, ThreadSession>();
    const live = (key: string, ttlMs: number, now: number): ThreadSession | undefined => liveThread(sessions.get(key), ttlMs, now, archived);
    return {
        get: async (key, ttlMs, now) => live(key, ttlMs, now),
        open: async (key, mintConversationId, ttlMs, now) => {
            const existing = live(key, ttlMs, now);
            const record: ThreadSession = existing
                ? { ...existing, lastAt: now, messages: existing.messages + 1 }
                : { conversationId: mintConversationId(), startedAt: now, lastAt: now, messages: 1 };
            sessions.set(key, record);
            return record;
        },
        settle: async (key, sessionId, now) => {
            const existing = sessions.get(key);
            if (existing !== undefined) {
                // An unknown session keeps the one the thread already had.
                sessions.set(key, sessionId === undefined ? { ...existing, lastAt: now } : { ...existing, lastAt: now, sessionId });
            }
        },
    };
};

// `archived`: whether the fleet the suite stands up has archived a conversation. `outboxStreamFor` is composed by the
// harness, since webchat already reaches this subsystem.
export const automationsSliceFake = (archived: ArchivedConversation) =>
    ({
        automations: memoryAutomationsStore(),
        // No held wakes: agents.list projects them as `held`, and no suite here holds one.
        heldWakes: {
            list: async () => [],
            get: async () => undefined,
            add: async (approval) => ({ ...approval, id: "held-1" }),
            remove: async () => false,
        },
        // In-memory: every inbound fire resolves its conversation through this; suites only need consistent answers.
        threadSessions: memoryThreadSessionsStore(archived),
    }) satisfies Partial<AutomationsSlice>;
