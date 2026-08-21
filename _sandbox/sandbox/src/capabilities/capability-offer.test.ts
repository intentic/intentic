import type { CapabilityCatalogEntry } from "@intentic-app/capability-catalog";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { resolveRequest } from "../agent/agent-requests.js";
import { type AskDeps, type AskedCapability, type AskInstance, createCapabilityGate } from "./capability-offer.js";

/* The setup gate, driven end to end with a fake catalog and a fake live turn: what these prove is the ONE
 * property the module exists for: nothing is watched for until a real reply accepted the card, and every
 * other ending (skip, expiry, a dead caller, an unknown card, an already-connected card) answers with a
 * sentence the agent can act on, without nagging the owner twice. */

// A cli card with a pinned provider discriminator (the shape most connectors take): what the join matches
// instances against.
const NOTION: CapabilityCatalogEntry = {
    id: "notion",
    name: "Notion",
    kind: "cli",
    category: "business",
    description: "Pages and databases as agent tools.",
    fields: [{ key: "provider", label: "", value: "notion" }],
};

interface Fake {
    readonly deps: AskDeps;
    readonly frames: AgentEvent[];
    readonly observed: AgentEvent[];
    // The live manifest the fake serves: tests mutate it to simulate the owner connecting something.
    readonly manifest: AskInstance[];
    // id → probed state; instances absent here probe as pending.
    readonly states: Map<string, "active" | "pending" | "error" | "inactive">;
}

const fake = (over: Partial<AskDeps> = {}): Fake => {
    const frames: AgentEvent[] = [];
    const observed: AgentEvent[] = [];
    const manifest: AskInstance[] = [];
    const states = new Map<string, "active" | "pending" | "error" | "inactive">();
    const deps: AskDeps = {
        cards: async () => [NOTION],
        list: async () => [...manifest],
        status: async (instance) => ({ state: states.get(instance.id) ?? "pending" }),
        liveRun: (conversationId) => ({ conversationId: conversationId ?? "sole-conv", push: (event) => frames.push(event) }),
        observe: (_conversationId, event) => observed.push(event),
        deadlineMs: 200,
        setupDeadlineMs: 200,
        pollMs: 2,
        ...over,
    };
    return { deps, frames, observed, manifest, states };
};

const asked = (over: Partial<AskedCapability> = {}): AskedCapability => ({
    card: "notion",
    why: "I'll create a page there for each research writeup",
    conversationId: "conv-1",
    signal: new AbortController().signal,
    ...over,
});

// The card's requestId exists only inside the frame the gate pushed: wait for it, then answer as the route
// handler would (resolveRequest is the same registry POST /agent/reply resolves).
const answerCard = async (frames: AgentEvent[], connect: boolean): Promise<void> => {
    while (frames.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const raised = frames[0]!;
    if (raised.kind !== "capability_offer") {
        throw new Error(`expected a capability_offer frame, got ${raised.kind}`);
    }
    resolveRequest({ kind: "capability_offer", requestId: raised.requestId, connect });
};

it("a yes parks the call on the setup, and the connection coming live answers it connected", async () => {
    const { deps, frames, observed, manifest, states } = fake();
    const gate = createCapabilityGate(deps);
    const pending = gate.ask(asked());
    await answerCard(frames, true);
    // The owner connects it while the agent waits: the watcher sees the manifest move.
    manifest.push({ id: "notion", kind: "cli", config: { provider: "notion" } });
    states.set("notion", "active");
    const answer = await pending;
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ connected: true, id: "notion" });
    // The card carried the catalog's words and the agent's one contribution, nothing else invented.
    expect(frames[0]).toMatchObject({ kind: "capability_offer", offer: { card: "notion", name: "Notion" } });
    expect((frames[0] as { offer: { why?: string } }).offer.why).toBe("I'll create a page there for each research writeup");
    // resolved (with the reply) and then the connected outcome followed it into the frame log and the registry.
    expect(frames.map((frame) => frame.kind)).toEqual(["capability_offer", "resolved", "capability_outcome"]);
    expect(frames[2]).toMatchObject({ kind: "capability_outcome", outcome: "connected", id: "notion" });
    expect(observed.map((frame) => frame.kind)).toEqual(["capability_offer", "resolved", "capability_outcome"]);
});

it("a skip connects nothing, tells the agent to continue without it, and is remembered for the conversation", async () => {
    const { deps, frames } = fake();
    const gate = createCapabilityGate(deps);
    const pending = gate.ask(asked());
    await answerCard(frames, false);
    const answer = await pending;
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "declined" } });
    // No outcome frame: nothing was set up; the resolved frame already says how it ended.
    expect(frames.map((frame) => frame.kind)).toEqual(["capability_offer", "resolved"]);
    // The repeat ask is answered without a second card: "don't nag" is plumbing, not etiquette.
    const repeat = await gate.ask(asked());
    expect(repeat.status).toBe(403);
    expect(JSON.parse(repeat.body)).toMatchObject({ error: { type: "declined" } });
    expect(frames.filter((frame) => frame.kind === "capability_offer")).toHaveLength(1);
});

it("a decline in one conversation does not silence the ask in another", async () => {
    const { deps, frames } = fake();
    const gate = createCapabilityGate(deps);
    const first = gate.ask(asked({ conversationId: "conv-1" }));
    await answerCard(frames, false);
    await first;
    const second = gate.ask(asked({ conversationId: "conv-2" }));
    while (frames.filter((frame) => frame.kind === "capability_offer").length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const raised = frames.findLast((frame) => frame.kind === "capability_offer")!;
    resolveRequest({ kind: "capability_offer", requestId: (raised as { requestId: string }).requestId, connect: false });
    expect((await second).status).toBe(403);
});

it("an ask nobody answers expires without connecting, and may be asked again later", async () => {
    const { deps, frames } = fake({ deadlineMs: 5 });
    const gate = createCapabilityGate(deps);
    const answer = await gate.ask(asked());
    expect(answer.status).toBe(408);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "unanswered" } });
    expect(frames.map((frame) => frame.kind)).toEqual(["capability_offer", "resolved"]);
    // The abort stand-in is nobody's decision: the resolved frame carries no reply, so the card freezes
    // cancelled rather than replaying as a skip somebody chose.
    expect((frames[1] as { reply?: unknown }).reply).toBeUndefined();
    // An expiry is not a no: the next ask (the owner showed up) raises a fresh card.
    const again = gate.ask(asked());
    while (frames.filter((frame) => frame.kind === "capability_offer").length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const raised = frames.findLast((frame) => frame.kind === "capability_offer")!;
    resolveRequest({ kind: "capability_offer", requestId: (raised as { requestId: string }).requestId, connect: false });
    await again;
    expect(frames.filter((frame) => frame.kind === "capability_offer")).toHaveLength(2);
});

it("the caller dying under the card settles it without connecting", async () => {
    const controller = new AbortController();
    const { deps, frames } = fake();
    const gate = createCapabilityGate(deps);
    const pending = gate.ask(asked({ signal: controller.signal }));
    while (frames.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    controller.abort();
    const answer = await pending;
    expect(answer.status).toBe(408);
});

it("a yes whose setup never finishes answers unfinished, with the outcome frame settling the card", async () => {
    const { deps, frames } = fake({ setupDeadlineMs: 10, pollMs: 2 });
    const gate = createCapabilityGate(deps);
    const pending = gate.ask(asked());
    await answerCard(frames, true);
    const answer = await pending;
    expect(answer.status).toBe(408);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "unfinished" } });
    expect(frames.map((frame) => frame.kind)).toEqual(["capability_offer", "resolved", "capability_outcome"]);
    expect(frames[2]).toMatchObject({ kind: "capability_outcome", outcome: "unfinished" });
});

it("asking again while the first card is still up is refused without a second card", async () => {
    const { deps, frames } = fake();
    const gate = createCapabilityGate(deps);
    const pending = gate.ask(asked());
    while (frames.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const repeat = await gate.ask(asked());
    expect(repeat.status).toBe(409);
    expect(JSON.parse(repeat.body)).toMatchObject({ error: { type: "already_asked" } });
    expect(frames.filter((frame) => frame.kind === "capability_offer")).toHaveLength(1);
    await answerCard(frames, false);
    await pending;
});

it("an already-connected card is an answer, not a card", async () => {
    const { deps, frames, manifest, states } = fake();
    manifest.push({ id: "notion", kind: "cli", config: { provider: "notion" } });
    states.set("notion", "active");
    const gate = createCapabilityGate(deps);
    const answer = await gate.ask(asked());
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ connected: true, id: "notion" });
    expect(frames).toEqual([]);
});

it("an instance that exists but is not live still raises the card: finishing its setup is the ask", async () => {
    const { deps, frames, manifest, states } = fake();
    manifest.push({ id: "notion", kind: "cli", config: { provider: "notion" } });
    states.set("notion", "error");
    const gate = createCapabilityGate(deps);
    const pending = gate.ask(asked());
    await answerCard(frames, false);
    await pending;
    expect(frames.filter((frame) => frame.kind === "capability_offer")).toHaveLength(1);
});

it("an unknown card is a sentence, not a card", async () => {
    const { deps, frames } = fake();
    const gate = createCapabilityGate(deps);
    const answer = await gate.ask(asked({ card: "nope" }));
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "unknown_capability" } });
    expect(frames).toEqual([]);
});

it("no live conversation refuses the ask outright", async () => {
    const { deps } = fake({ liveRun: () => undefined });
    const gate = createCapabilityGate(deps);
    const answer = await gate.ask(asked({ conversationId: undefined }));
    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "no_conversation" } });
});

it("the reserved owner names are no conversation at all", async () => {
    const requested: (string | undefined)[] = [];
    const { deps } = fake({
        liveRun: (conversationId) => {
            requested.push(conversationId);
            return undefined;
        },
    });
    const gate = createCapabilityGate(deps);
    await gate.ask(asked({ conversationId: "daemon" }));
    await gate.ask(asked({ conversationId: "one-shot" }));
    expect(requested).toEqual([undefined, undefined]);
});

it("the agent's why is capped to one line's worth, and the card's title stays the catalog's", async () => {
    const { deps, frames } = fake();
    const gate = createCapabilityGate(deps);
    const pending = gate.ask(asked({ why: "x".repeat(500) }));
    await answerCard(frames, false);
    await pending;
    const offer = (frames[0] as { offer: { name: string; why?: string } }).offer;
    expect(offer.name).toBe("Notion");
    expect(offer.why).toHaveLength(280);
});
