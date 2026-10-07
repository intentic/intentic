import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AcpAgentConfig, AgentEvent } from "@intentic/sandbox-contract";
import type { AgentRequest, ContainerCredential, TurnPolicy, TurnSpec } from "../../agent/providers/agent-request.js";
import { fakeAcpAgentApp, fakeAcpConnection } from "./__fixtures__/fake-acp-agent.js";
import { createAcpAgent } from "./acp-agent.js";
import type { TurnTimeouts } from "../decorators/turn-watchdog.js";
import type { AcpConnection, AcpConnections } from "./acp-connection.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../testing.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

// The adapter under test is the real one; only the connection is the in-process fixture (no spawn).
const connectionsOf = (connection: AcpConnection): AcpConnections => ({
    acquire: async () => connection,
    drop: () => {},
});

const CONFIG: AcpAgentConfig = { command: "fake acp" };
const TIMEOUTS: TurnTimeouts = { inactivityMs: 60_000, maxTurnMs: 60_000 };

const request = (
    prompt: string,
    overrides: { readonly spec?: Pick<TurnSpec, "sessionId">; readonly policy?: Pick<TurnPolicy, "permissionMode"> } = {},
): AgentRequest<ContainerCredential> => ({
    spec: { prompt, cwd: WORKSPACE_ROOT, ...overrides.spec },
    policy: { ...overrides.policy },
    tools: {},
    credential: { kind: "container" },
    hooks: { cards },
    signal: new AbortController().signal,
});

const collect = async (
    agent: ReturnType<typeof createAcpAgent>,
    turnRequest: AgentRequest<ContainerCredential>,
    onPlan?: (requestId: string) => { approve: boolean; feedback?: string },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent("fake", CONFIG, turnRequest)) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan(event.requestId);
            setTimeout(() => cards.resolve({ kind: "plan", requestId: event.requestId, ...decision }), 0);
        }
    }
    return events;
};

test("a turn creates a session, streams deltas, and ends with done", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
    const events = await collect(agent, request("hello"));
    expect(events[0]).toEqual({ kind: "session", sessionId: "fake-1" });
    expect(events).toContainEqual({ kind: "delta", text: "Hi there" });
    expect(events.at(-1)).toEqual({ kind: "done" });
});

test("tool calls pass through with ACP's kind/status/locations/diff, relativized onto the workspace", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
    const events = await collect(agent, request("use the tool"));
    expect(events).toContainEqual({
        kind: "tool_call",
        id: "t1",
        name: "Edit",
        category: "edit",
        status: "in_progress",
        locations: [{ path: "src/app.ts", line: 3 }],
        content: [{ type: "diff", path: "src/app.ts", oldText: "a", newText: "b" }],
    });
    expect(events).toContainEqual({ kind: "tool_call_update", id: "t1", status: "completed" });
});

test("ACP's plan checklist arrives as todos", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
    const events = await collect(agent, request("show the checklist"));
    expect(events).toContainEqual({ kind: "todos", items: [{ content: "step 1", status: "in_progress" }] });
});

test("a permission request is auto-allowed (container is the boundary)", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
    const events = await collect(agent, request("ask-permission please"));
    expect(events).toContainEqual({ kind: "delta", text: "permission:allow" });
});

test("refusal surfaces as an error frame, then done", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
    const events = await collect(agent, request("refuse this"));
    expect(events).toContainEqual({ kind: "error", message: "The agent refused this request." });
    expect(events.at(-1)).toEqual({ kind: "done" });
});

test("a throwing prompt surfaces the agent's error, then done", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
    const events = await collect(agent, request("explode now"));
    const error = events.find((event) => event.kind === "error");
    expect(error?.kind === "error" && error.message.includes("exploded")).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "done" });
});

test("a stalled agent trips the inactivity watchdog: cancel, end the process no other turn is on, error, done", async () => {
    const connection = fakeAcpConnection(fakeAcpAgentApp());
    const agent = createAcpAgent(connectionsOf(connection), { inactivityMs: 100, maxTurnMs: 60_000 });
    const events = await collect(agent, request("stall forever"));
    const error = events.find((event) => event.kind === "error");
    expect(error?.kind === "error" && error.message.includes("timed out")).toBe(true);
    expect(connection.alive()).toBe(false);
    expect(events.at(-1)).toEqual({ kind: "done" });
});

// The process is every conversation's on this agent: one turn's stall must not take down another's turn on it.
test("a stalled turn gives up its own session and leaves the process to another conversation's turn", async () => {
    const connection = fakeAcpConnection(fakeAcpAgentApp());
    const patient = createAcpAgent(connectionsOf(connection), TIMEOUTS);
    const hasty = createAcpAgent(connectionsOf(connection), { inactivityMs: 100, maxTurnMs: 60_000 });
    const stop = new AbortController();
    const other = collect(patient, { ...request("stall until stopped"), signal: stop.signal });

    const events = await collect(hasty, request("stall forever"));

    expect(events.find((event) => event.kind === "error")).toMatchObject({ message: expect.stringContaining("timed out") });
    expect(connection.alive()).toBe(true);
    stop.abort();
    expect((await other).at(-1)).toEqual({ kind: "done" });
});

test("resuming a session the process doesn't know without loadSession self-heals via session-not-found", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
    const events = await collect(agent, request("hello", { spec: { sessionId: "stale-id" } }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "error", code: "session-not-found" }));
    expect(events.at(-1)).toEqual({ kind: "done" });
});

test("an agent that answers session/load with resource-not-found self-heals via session-not-found", async () => {
    const connection = fakeAcpConnection(fakeAcpAgentApp({ failure: { method: "load", code: -32002, message: "Session missing" } }), { loadSession: true });
    const agent = createAcpAgent(connectionsOf(connection), TIMEOUTS);
    const events = await collect(agent, request("hello", { spec: { sessionId: "stale-id" } }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "error", code: "session-not-found" }));
});

// session-not-found makes the client drop the id for good; a dropped connection has said nothing about the session.
test("a connection that drops during session/load fails the turn without discarding the session", async () => {
    const base = fakeAcpConnection(fakeAcpAgentApp(), { loadSession: true });
    const closed = (async () => {
        throw new Error("ACP connection closed");
    }) as typeof base.agent.request;
    const dropped: AcpConnection = { ...base, agent: Object.assign(Object.create(base.agent) as typeof base.agent, { request: closed }) };
    const events = await collect(createAcpAgent(connectionsOf(dropped), TIMEOUTS), request("hello", { spec: { sessionId: "live-id" } }));
    expect(events).toEqual([{ kind: "error", message: "ACP connection closed" }, { kind: "done" }]);
});

test("plan mode runs the two-phase emulation: captured plan → approval → execute on the same session", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
    const events = await collect(agent, request("plan the work", { policy: { permissionMode: "plan" } }), () => ({ approve: true }));
    const plan = events.find((event) => event.kind === "plan");
    expect(plan?.kind === "plan" && plan.text).toBe("1. do the thing");
    expect(events).toContainEqual({ kind: "delta", text: "executed" });
    expect(events.at(-1)).toEqual({ kind: "done" });
});

// A turn whose owner's rules hold a command for a person: the policy the planner gives an ACP agent's turn, and a judge
// that asks.
const heldRequest = (prompt: string): AgentRequest<ContainerCredential> => ({
    ...request(prompt),
    policy: { judging: "on", rulebook: "approval" },
    hooks: { cards, judge: async () => ({ decision: "ask", sentence: "Rewrites the shared history of main." }) },
});

// The agent waits on the daemon while a card is open, not the other way round: the phase's silence limit is held for
// as long as the person takes, and runs again once they answer.
test("an approval card holds the watchdog: the agent waits past the silence limit, and the person's yes reaches it", async () => {
    const connection = fakeAcpConnection(fakeAcpAgentApp());
    const agent = createAcpAgent(connectionsOf(connection), { inactivityMs: 100, maxTurnMs: 60_000 });
    const events: AgentEvent[] = [];
    for await (const event of agent("fake", CONFIG, heldRequest("ask-to-force-push"))) {
        events.push(event);
        if (event.kind === "permission") {
            // Four silence windows on the card before anyone answers.
            await new Promise((resolve) => setTimeout(resolve, 400));
            expect(cards.resolve({ kind: "permission", requestId: event.requestId, decision: "once" })).toBe("settled");
        }
    }

    expect(events.map((event) => event.kind).filter((kind) => kind !== "session")).toEqual(["permission", "resolved", "delta", "done"]);
    expect(events).toContainEqual({ kind: "delta", text: "permission:allow" });
    expect(connection.alive()).toBe(true);
});

// An agent can end its turn with an ask unanswered (its process died, or it moved on); the card is settled as the turn
// ends, and the agent is told no, rather than the card staying open on nobody.
test("an ask the agent left unanswered is refused when its turn ends", async () => {
    let answer: (outcome: string) => void = () => {};
    const answered = new Promise<string>((resolve) => {
        answer = resolve;
    });
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp({ answered: answer }))), TIMEOUTS);

    const events = await collect(agent, heldRequest("ask-and-leave"));

    expect(events.at(-1)).toEqual({ kind: "done" });
    // A hang bound, not a timing: without the turn's end settling it, the card waits for ever.
    expect(await Promise.race([answered, new Promise((resolve) => setTimeout(() => resolve("never answered"), 5_000))])).toBe("deny");
});

for (const method of ["load", "new", "prompt"] as const) {
    test(`auth_required on session/${method} surfaces a coded sign-in failure and preserves the session`, async () => {
        const connection = fakeAcpConnection(fakeAcpAgentApp({ failure: { method, code: -32000, message: "Sign in to the agent" } }), { loadSession: true });
        const events = await collect(
            createAcpAgent(connectionsOf(connection), TIMEOUTS),
            request("hello", { spec: method === "load" ? { sessionId: "live-id" } : {} }),
        );
        expect(events.filter((event) => event.kind !== "session")).toEqual([
            { kind: "error", code: "acp-auth-required", message: "Sign in to the agent" },
            { kind: "done" },
        ]);
    });
}

test("an internal session/load failure preserves the session and the agent's message", async () => {
    const connection = fakeAcpConnection(fakeAcpAgentApp({ failure: { method: "load", code: -32603, message: "Replay failed" } }), { loadSession: true });
    const events = await collect(createAcpAgent(connectionsOf(connection), TIMEOUTS), request("hello", { spec: { sessionId: "live-id" } }));
    expect(events).toEqual([{ kind: "error", message: "Replay failed" }, { kind: "done" }]);
});
