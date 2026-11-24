import { memoryFleet } from "../registry/agents-registry.testing.js";
import { haltConversation, haltOf, liftHalt, liftHaltOnStart } from "./conversation-halt.js";

// A cancel's halt stands until somebody writes to the conversation: a re-run the sandbox sends by itself carries its first
// sender as its speaker, and must not read as that sender writing again.
describe("the halt a cancel leaves", () => {
    const halted = (): ReturnType<typeof memoryFleet>["conversations"] => {
        const { conversations } = memoryFleet();
        haltConversation(conversations, "sub-slice", "agent", 1_000);
        return conversations;
    };

    it("stands with who cancelled it and when, until it is lifted", () => {
        const conversations = halted();
        expect(haltOf(conversations, "sub-slice")).toEqual({ at: 1_000, by: "agent" });
        expect(liftHalt(conversations, "sub-slice")).toBe(true);
        expect(haltOf(conversations, "sub-slice")).toBeUndefined();
        expect(liftHalt(conversations, "sub-slice")).toBe(false);
    });

    it("is lifted by a turn on words a person, a program or an agent wrote, and by a person's Continue", () => {
        for (const speaker of [
            { kind: "person" as const, email: "owner@example.com" },
            { kind: "program" as const, token: "ci" },
            { kind: "agent" as const, conversationId: "conv-orchestrator" },
        ]) {
            const conversations = halted();
            liftHaltOnStart(conversations, { conversationId: "sub-slice", speaker, resume: undefined });
            expect(haltOf(conversations, "sub-slice")).toBeUndefined();
        }
        const conversations = halted();
        liftHaltOnStart(conversations, { conversationId: "sub-slice", speaker: { kind: "person", email: "owner@example.com" }, resume: "continued" });
        expect(haltOf(conversations, "sub-slice")).toBeUndefined();
    });

    it("stays through the sandbox's own wake and through a re-run it sent by itself, whoever first asked", () => {
        const conversations = halted();
        liftHaltOnStart(conversations, { conversationId: "sub-slice", speaker: { kind: "sandbox", source: "watch" }, resume: undefined });
        liftHaltOnStart(conversations, { conversationId: "sub-slice", speaker: undefined, resume: undefined });
        liftHaltOnStart(conversations, { conversationId: "sub-slice", speaker: { kind: "agent", conversationId: "conv-orchestrator" }, resume: "memory" });
        liftHaltOnStart(conversations, { conversationId: "sub-slice", speaker: { kind: "agent", conversationId: "conv-orchestrator" }, resume: "continued" });
        expect(haltOf(conversations, "sub-slice")).toEqual({ at: 1_000, by: "agent" });
    });

    it("goes with the conversation it marks", async () => {
        const conversations = halted();
        await conversations.dispose(["sub-slice"]);
        expect(haltOf(conversations, "sub-slice")).toBeUndefined();
    });
});
