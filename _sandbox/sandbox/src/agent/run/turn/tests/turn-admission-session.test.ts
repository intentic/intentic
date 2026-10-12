import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../../composition.js";
import type { QueuedItem } from "../../../../conversations/actor/conversation-queue.js";
import { createDomainEvents } from "../../../../seams/domain-events.js";
import type { TurnInput } from "../../../../seams/turn-starter.js";
import { beginTurn, memoryFleet } from "../../../../testing.js";
import { turnDoors } from "../turn-doors.js";

// Which session a wake continues, decided by the conversation's admission and nobody else: a watch armed on one routing
// reports to a conversation that has moved to another, and the session it continues is the one minted on the routing the
// conversation has when the wake goes out, whichever way the wake goes out (at once, or when the queue lets it).

// A conversation that last ran on Codex and holds that session.
const onCodex = async () => {
    const fleet = memoryFleet();
    await fleet.agents.init();
    await beginTurn(
        fleet.conversations,
        { conversationId: "c1", isolated: false, prompt: "earlier", profile: { agent: "codex", harness: "native", model: "gpt-5.6" } },
        1,
    );
    fleet.conversations.send("c1", { kind: "frame", frame: { kind: "session", sessionId: "sess-codex" } });
    await fleet.conversations.send("c1", { kind: "settle" }, 2).settled;
    return fleet;
};

const doorsOver = (fleet: Awaited<ReturnType<typeof onCodex>>) => {
    const seen: TurnInput[] = [];
    const services = unstubbed<Services>("services", {
        agents: fleet.agents,
        conversations: fleet.conversations,
        events: createDomainEvents(() => {}),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: "/nowhere/admission-sessions" }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { append: async () => {}, count: async () => 0 }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {} }),
    });
    const turns = turnDoors(
        () => services,
        async function* (input) {
            seen.push(input);
            yield { kind: "done" };
        },
    );
    return { turns, seen };
};

// What the watch captured when it was armed: a routing and a session the conversation has left behind.
const STALE = { conversationId: "c1", prompt: "Watch fired: …", agent: "claude", harness: "native", model: "opus", sessionId: "sess-stale" } as const;

test("a wake that goes out at once continues the conversation's session on the routing the conversation has now", async () => {
    const { turns, seen } = doorsOver(await onCodex());
    expect(await turns.say({ voice: "sandbox", turn: STALE })).toMatchObject({ delivered: "started" });
    expect(seen.map((turn) => [turn.agent, turn.model, turn.sessionId])).toEqual([["codex", "gpt-5.6", "sess-codex"]]);
});

test("a wake the queue lets out later continues the same session on the same routing", async () => {
    const fleet = await onCodex();
    const { turns, seen } = doorsOver(fleet);
    const waiting: QueuedItem = { id: "w1", voice: "sandbox", queuedAt: 0, revision: 1, turn: { ...STALE, messageId: "w1" } };
    await fleet.conversations.send("c1", { kind: "queue-joined", item: waiting }).settled;
    await turns.drain("c1");
    expect(seen.map((turn) => [turn.agent, turn.model, turn.sessionId])).toEqual([["codex", "gpt-5.6", "sess-codex"]]);
});

test("a wake into a conversation not on record keeps the session it names", async () => {
    const { turns, seen } = doorsOver(await onCodex());
    await turns.say({ voice: "sandbox", turn: { ...STALE, conversationId: "c2" } });
    expect(seen.map((turn) => [turn.conversationId, turn.agent, turn.sessionId])).toEqual([["c2", "claude", "sess-stale"]]);
});
