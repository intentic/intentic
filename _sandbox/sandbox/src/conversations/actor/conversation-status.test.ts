import type { AgentWatch, ProgramAsk } from "@intentic/sandbox-contract";
import { awaitingWake, type ConversationState, idleConversation, type ParkedCard } from "./conversation-state.js";
import { type QueuedItem, scheduled } from "./conversation-queue.js";
import { conversationStatus, permissionAskOf } from "./conversation-status.js";

// A settled conversation's status, read from its state and branch: `ready` claims the work is finished and awaits a
// land, which a conversation that armed its own next turn has not. What wakes it is read from what it holds.

const WATCH: AgentWatch = { id: "w1", note: "CI run", intervalSeconds: 60, deadlineAt: 1 };

// A conversation idle with one watch armed on it.
const watched = (): ConversationState => ({ ...idleConversation(), watches: [WATCH] });

// A conversation idle with one message waiting, in the voice given, and its queue held or not.
const waiting = (voice: QueuedItem["voice"], paused = false): ConversationState => {
    const item: QueuedItem = { id: "m1", voice, queuedAt: 1, revision: 1, turn: { prompt: "go", conversationId: "c1" } };
    return { ...idleConversation(), queue: { items: [item], revision: 1, ...(paused ? { paused: "stopped" as const } : {}) } };
};

describe("a settled conversation holding work on its branch", () => {
    test("with nothing armed is ready to land", () => {
        expect(conversationStatus(idleConversation(), "idle", "ready")).toBe("ready");
        expect(conversationStatus(undefined, "idle", "ready")).toBe("ready");
    });

    test("that wakes itself is idle, since the wake is the turn that finishes it", () => {
        expect(conversationStatus(watched(), "idle", "ready")).toBe("idle");
    });
});

describe("waking itself leaves every other reading as it is", () => {
    test.each(["landed", "conflict", "idle"] as const)("a %s standing", (standing) => {
        expect(conversationStatus(watched(), "idle", standing)).toBe(standing);
    });

    test("how the last turn ended", () => {
        expect(conversationStatus(watched(), "error", "ready")).toBe("error");
    });
});

describe("awaiting a wake", () => {
    test("is an armed watch, or the sandbox's or an agent's words waiting in a queue nothing holds", () => {
        expect(awaitingWake(idleConversation())).toBe(false);
        expect(awaitingWake(watched())).toBe(true);
        expect(awaitingWake(waiting("sandbox"))).toBe(true);
        expect(awaitingWake(waiting("agent"))).toBe(true);
    });

    // A person's waiting message is theirs to have sent, and a held queue goes nowhere until somebody says go.
    test("is not a person's waiting message, nor anything in a held queue", () => {
        expect(awaitingWake(waiting("person"))).toBe(false);
        expect(awaitingWake(waiting("sandbox", true))).toBe(false);
    });

    // A person's booked message is no hold on the sandbox's own words: they still go when the conversation is free.
    test("is the sandbox's words beside a person's booked message, which holds nothing", () => {
        const sandbox = waiting("sandbox");
        const booked = scheduled(sandbox.queue, { id: "b1", voice: "person", queuedAt: 2, turn: { prompt: "later", conversationId: "c1" } }, { until: 9_000 });
        expect(booked.paused).toBe("scheduled");
        expect(awaitingWake({ ...sandbox, queue: booked })).toBe(true);
        expect(awaitingWake({ ...sandbox, queue: { ...booked, items: booked.items.filter((item) => item.id === "b1") } })).toBe(false);
    });
});

// What a card offers to answer: the oldest permission a live turn waits on, and nothing a stop is taking down with it.
describe("the permission a card can answer", () => {
    const parkedOn = (parked: readonly ParkedCard[], stopping?: "stopped"): ConversationState => ({
        ...idleConversation(),
        phase: { kind: "running", startedAt: 1, parked, stopping },
    });

    test("is the oldest permission parked, with its line", () => {
        const state = parkedOn([
            { requestId: "q-1", kind: "question" },
            { requestId: "p-1", kind: "permission", ask: "Run `pnpm build`?" },
            { requestId: "p-2", kind: "permission", ask: "Read file" },
        ]);
        expect(permissionAskOf(state)).toEqual({ requestId: "p-1", ask: "Run `pnpm build`?" });
    });

    test("carries the program it holds, so the card can show what would run", () => {
        const program: ProgramAsk = { text: "adb shell rm -rf /sdcard/Download/old", language: "bash", truncated: false, spans: [] };
        const state = parkedOn([{ requestId: "p-1", kind: "permission", ask: "Run this on rog?", program }]);
        expect(permissionAskOf(state)).toEqual({ requestId: "p-1", ask: "Run this on rog?", program });
    });

    test("is none while only other cards wait, nor once a stop is unwinding, nor with no turn", () => {
        expect(permissionAskOf(parkedOn([{ requestId: "q-1", kind: "question" }]))).toBeUndefined();
        expect(permissionAskOf(parkedOn([{ requestId: "p-1", kind: "permission", ask: "Read file" }], "stopped"))).toBeUndefined();
        expect(permissionAskOf(idleConversation())).toBeUndefined();
        expect(permissionAskOf(undefined)).toBeUndefined();
    });
});
