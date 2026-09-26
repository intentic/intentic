import type { AgentWatch } from "@intentic/sandbox-contract";
import { awaitingWake, type ConversationState, idleConversation } from "./conversation-state.js";
import type { QueuedItem } from "./conversation-queue.js";
import { conversationStatus } from "./conversation-status.js";

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
});
