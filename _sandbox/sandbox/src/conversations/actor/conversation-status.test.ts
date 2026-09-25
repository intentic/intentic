import { idleConversation } from "./conversation-state.js";
import { conversationStatus } from "./conversation-status.js";

// A settled conversation's status, read from its state and branch: `ready` claims the work is finished and awaits a
// land, which a conversation that armed its own next turn has not. What counts as armed is background-jobs.test.ts's.

describe("a settled conversation holding work on its branch", () => {
    test("with nothing armed is ready to land", () => {
        expect(conversationStatus(idleConversation(), "idle", "ready", false)).toBe("ready");
        expect(conversationStatus(undefined, "idle", "ready", false)).toBe("ready");
    });

    test("that wakes itself is idle, since the wake is the turn that finishes it", () => {
        expect(conversationStatus(idleConversation(), "idle", "ready", true)).toBe("idle");
    });
});

describe("waking itself leaves every other reading as it is", () => {
    test.each(["landed", "conflict", "idle"] as const)("a %s standing", (standing) => {
        expect(conversationStatus(idleConversation(), "idle", standing, true)).toBe(standing);
    });

    test("how the last turn ended", () => {
        expect(conversationStatus(idleConversation(), "error", "ready", true)).toBe("error");
    });
});
