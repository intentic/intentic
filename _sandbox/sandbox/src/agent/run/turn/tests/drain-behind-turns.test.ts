import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { beginTurn } from "../../../../conversations/actor/conversation-actors.testing.js";
import type { BeginTurn } from "../../../../conversations/actor/conversation-decide.js";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { createDomainEvents, type DomainEventMap } from "../../../../seams/domain-events.js";
import { drainBehindTurns } from "../turn-doors.js";

// Words a person queued behind a running turn go the moment it settles, drained on `run.settled`, which the settle's own
// roster goes out well ahead of: until their turn began the card read the ending they were about to answer, a failure's
// in Attention, and went back to Active a moment later.

const turn = (): BeginTurn => ({
    conversationId: "c1",
    isolated: true,
    prompt: "Fix the login bug",
    profile: { agent: "claude", harness: "native" },
});

const settledOf = (): DomainEventMap["run.settled"] => ({
    conversationId: "c1",
    run: "run-1",
    actor: "dev@example.com",
    speaker: undefined,
    failure: "Provider refused.",
    closing: "",
});

const failingWithWordsBehind = async (queued: { readonly hold?: boolean } = {}) => {
    const fleet = memoryFleet();
    await fleet.agents.init();
    const events = createDomainEvents(() => {});
    let drained: () => void = () => undefined;
    const drains: string[] = [];
    drainBehindTurns({
        conversations: fleet.conversations,
        events,
        turns: {
            drain: (conversationId) => {
                drains.push(conversationId);
                return new Promise<void>((resolve) => {
                    drained = resolve;
                });
            },
        },
    });
    await beginTurn(fleet.conversations, turn(), 1_000);
    await fleet.conversations.send("c1", {
        kind: "queue-joined",
        item: { id: "m1", voice: "person", queuedAt: 1_050, turn: { conversationId: "c1", prompt: "and the logout one" } },
    }).settled;
    if (queued.hold === true) {
        await fleet.conversations.send("c1", { kind: "stop", ending: "stopped" }).settled;
    }
    const frames: AgentSummary[][] = [];
    fleet.agents.subscribe((agents) => frames.push(agents));
    await fleet.conversations.send("c1", { kind: "frame", frame: { kind: "error", message: "Provider refused." } }).settled;
    await fleet.conversations.send("c1", { kind: "settle" }, 1_100).settled;
    const statuses = () => frames.slice(1).map((frame) => frame.find((agent) => agent.id === "c1")?.status);
    return { events, statuses, drains, drained: () => drained() };
};

describe("words waiting behind a turn", () => {
    it("are a turn on its way from the settle to the drain, never the failure they are about to answer", async () => {
        const { events, statuses, drains, drained } = await failingWithWordsBehind();
        expect(statuses().at(-1)).toBe("resuming");

        events.publish("run.settled", settledOf());
        expect(drains).toEqual(["c1"]);
        // The drain found them held behind something: the card reads its ending again, told so.
        drained();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(statuses().at(-1)).toBe("error");
        expect(statuses()).not.toContain("running");
    });

    it("marks nothing behind a stop, which holds the queue for the person's own press", async () => {
        const { statuses } = await failingWithWordsBehind({ hold: true });
        expect(statuses()).not.toContain("resuming");
    });
});
