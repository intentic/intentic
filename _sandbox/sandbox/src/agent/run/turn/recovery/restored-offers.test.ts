import type { ParkedRequest } from "@intentic/sandbox-contract/events/requests";
import { parkedCards } from "../../../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { permissionAnswer, restoreParkedCard } from "./restored-offers.js";

// A card put back after a restart answers to the rules it went up with, read off its own frame, and its answer is acted
// on by whoever owns it, once.

type PermissionRequest = Extract<ParkedRequest, { kind: "permission" }>;
const permission = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({ kind: "permission", requestId: "r-1", toolName: "omen__run_command", ...over });

// The cards of a fleet whose conversation c-1 holds "allow everything in this conversation".
const standingYes = () =>
    parkedCards(memoryFleet().conversations, { allowed: async (conversationId) => conversationId === "c-1", allow: async () => {}, failed: () => {} });

describe("a card put back after a restart", () => {
    // 2026-10-20: a hard rule's card came back without its `alwaysAsks`, and the conversation's standing yes answered it.
    it("still always asks when its frame says so: the conversation's standing yes answers only the other", async () => {
        const cards = standingYes();
        const controller = new AbortController();
        const hard = restoreParkedCard(cards, permission({ requestId: "hard", alwaysAsks: true }), "c-1").wait(controller.signal);
        const plain = restoreParkedCard(cards, permission({ requestId: "plain" }), "c-1").wait(controller.signal);
        expect((await plain).reply).toMatchObject({ kind: "permission", requestId: "plain", decision: "everything" });
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.abort();
        expect((await hard).resolved.reply).toBeUndefined();
    });

    it("answers a credential's release only to the approvers it names", async () => {
        const cards = standingYes();
        const card = restoreParkedCard(
            cards,
            {
                kind: "credential_offer",
                requestId: "cred",
                offer: { subject: "GitHub", kind: "capability", lane: "gateway", approvers: ["ops@example.com"], scope: "conversation" },
            },
            "c-1",
        );
        const settled = card.wait(new AbortController().signal);
        expect(cards.resolve({ kind: "credential_offer", requestId: "cred", approve: true }, { email: "someone@example.com", role: "collaborator" })).toEqual({
            refused: 'Only ops@example.com can release "GitHub".',
        });
        expect(cards.resolve({ kind: "credential_offer", requestId: "cred", approve: true }, { email: "ops@example.com", role: "collaborator" })).toBe("settled");
        expect((await settled).reply).toMatchObject({ approve: true });
    });
});

describe("what a restored permission card's answer starts", () => {
    // A held child start's card answers the start, which its own record carries on with: the turn told to make the call
    // again started the child a second time.
    it("tells the turn a held child start is under way, and grants no call to make again", () => {
        const spawn = permission({ toolName: "agents.spawn", child: { move: "spawn", provider: "claude", model: "claude-sonnet-4-6", task: "Port the parser" } });
        expect(permissionAnswer(spawn, { kind: "permission", requestId: "r-1", decision: "once" })).toEqual({
            words: 'The owner allowed the subagent start you asked for ("Port the parser"): it starts by itself and its report reaches you when it ends. Do not start it again.',
            grant: false,
        });
    });

    it("grants any other call once, to make again, and a deny with a note redirects while a bare one ends the turn", () => {
        expect(permissionAnswer(permission(), { kind: "permission", requestId: "r-1", decision: "always" })).toEqual({
            words: "The user allowed omen__run_command: run it and continue where the session left off.",
            grant: true,
        });
        expect(permissionAnswer(permission(), { kind: "permission", requestId: "r-1", decision: "deny", feedback: " use the staging box " })).toEqual({ words: "use the staging box", grant: false });
        expect(permissionAnswer(permission(), { kind: "permission", requestId: "r-1", decision: "deny" })).toEqual({ words: undefined, grant: false });
    });
});
