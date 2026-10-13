import type { McpServer, NewSessionRequest } from "@agentclientprotocol/sdk";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { AgentRequest, ContainerCredential, TurnPolicy, TurnSpec } from "../../agent/providers/agent-request.js";
import { fakeAcpAgentApp, fakeAcpConnection } from "./__fixtures__/fake-acp-agent.js";
import { type AcpTurnOptions, createAcpAgent } from "./acp-agent.js";
import type { TurnTimeouts } from "../decorators/turn-watchdog.js";
import type { AcpConnection, AcpConnections } from "./acp-connection.js";
import type { AcpLaunch, AcpSessionMeta } from "./acp-spawn.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../testing.js";
import { createTurnRelay } from "../daemon-tools/turn-relay.js";
import { PROXY_BEARER_ENV, PROXY_URL_ENV } from "./acp-mcp-proxy.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

// The adapter under test is the real one; only the connection is the in-process fixture (no spawn).
const connectionsOf = (connection: AcpConnection): AcpConnections => ({
    acquire: async () => connection,
    drop: () => {},
});

const LAUNCH: AcpLaunch = { argv: ["fake", "acp"], env: {} };
const TIMEOUTS: TurnTimeouts = { inactivityMs: 60_000, maxTurnMs: 60_000 };

const request = (
    prompt: string,
    overrides: { readonly spec?: Pick<TurnSpec, "sessionId" | "effort">; readonly policy?: Pick<TurnPolicy, "permissionMode"> } = {},
): AgentRequest<ContainerCredential> => ({
    execution: unstubbed("execution", {}),
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
    options?: AcpTurnOptions,
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent("fake", LAUNCH, turnRequest, options)) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan(event.requestId);
            setTimeout(() => cards.resolve({ kind: "plan", requestId: event.requestId, ...decision }), 0);
        }
    }
    return events;
};

// A native provider on this runtime (Devin) names the model; the agent's own option is the only door to it.
test("a named model switches the session before the prompt, and the turn announces it once", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp({ models: ["swe", "opus"] }))), TIMEOUTS);
    const events = await collect(agent, request("hello"), undefined, { model: "opus" });
    expect(events.filter((event) => event.kind === "init")).toEqual([{ kind: "init", model: "opus" }]);
    expect(events).toContainEqual({ kind: "delta", text: "Hi there from opus" });
    expect(events.at(-1)).toEqual({ kind: "done" });
});

test("a model the session's own list leaves out refuses the turn before anything is sent", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp({ models: ["swe", "opus"] }))), TIMEOUTS);
    const events = await collect(agent, request("hello"), undefined, { model: "gpt" });
    expect(events).toContainEqual(
        expect.objectContaining({ kind: "error", code: "model-unavailable", message: expect.stringContaining("SWE, OPUS") }),
    );
    expect(events.some((event) => event.kind === "delta")).toBe(false);
});

test("a turn naming no model leaves the agent's own pick alone and announces nothing", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp({ models: ["swe", "opus"] }))), TIMEOUTS);
    const events = await collect(agent, request("hello"));
    expect(events.some((event) => event.kind === "init")).toBe(false);
    expect(events).toContainEqual({ kind: "delta", text: "Hi there" });
});

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
    for await (const event of agent("fake", LAUNCH, heldRequest("ask-to-force-push"))) {
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

// What the agent said back, joined: the fixture answers a posture probe in one delta.
const said = (events: readonly AgentEvent[]): string =>
    events.flatMap((event) => (event.kind === "delta" ? [event.text] : [])).join("");

// Devin's CLI's modes as it advertises them (its `accept-edits` is the session's own default).
const DEVIN_MODES = [
    { id: "accept-edits", name: "Code" },
    { id: "ask", name: "Ask" },
    { id: "plan", name: "Plan" },
    { id: "bypass", name: "Bypass Permissions" },
];

// Drives a turn, answering every card it raises as `answer` says, and collects its frames.
const answering = async (
    agent: ReturnType<typeof createAcpAgent>,
    turnRequest: AgentRequest<ContainerCredential>,
    answer: (event: AgentEvent) => Parameters<typeof cards.resolve>[0] | undefined,
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent("fake", LAUNCH, turnRequest)) {
        events.push(event);
        const reply = answer(event);
        if (reply !== undefined) {
            setTimeout(() => cards.resolve(reply), 0);
        }
    }
    return events;
};

describe("the agent's own modes carry the turn's posture", () => {
    // Every turn's gate enforces today (turn-gate.ts turnIsGated), so a run-without-asking turn never hands the agent
    // its bypass mode: the asks it would stop sending are what the rulebook reads.
    test("a run-without-asking turn keeps the agent in its own mode, so its asks still reach the rulebook", async () => {
        const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp({ modes: DEVIN_MODES }))), TIMEOUTS);
        expect(said(await collect(agent, request("which-mode")))).toBe("mode:accept-edits");
    });

    test("while the owner's rulebook watches, the session stays in its own mode so its asks still reach the rulebook", async () => {
        const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp({ modes: DEVIN_MODES }))), TIMEOUTS);
        expect(said(await collect(agent, heldRequest("which-mode")))).toBe("mode:accept-edits");
    });

    test("planning runs in the agent's plan mode, and the plan card is still the daemon's", async () => {
        const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp({ modes: DEVIN_MODES }))), TIMEOUTS);
        const events = await collect(agent, request("which-mode", { policy: { permissionMode: "plan" } }), () => ({ approve: true }));
        expect(events.find((event) => event.kind === "plan")).toMatchObject({ text: "mode:plan" });
        // Approved, the execute phase leaves plan mode for the posture the turn runs under.
        expect(said(events)).toBe("executed");
    });

    test("an agent advertising no modes is left as it is", async () => {
        const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
        expect(said(await collect(agent, request("which-mode")))).toBe("mode:none");
    });
});

describe("a turn in default mode puts each call the agent asks about to a person", () => {
    test("the agent's ask becomes a permission card, and the person's no reaches the agent", async () => {
        const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp({ modes: DEVIN_MODES }))), TIMEOUTS);
        const events = await answering(agent, request("ask-permission", { policy: { permissionMode: "default" } }), (event) =>
            event.kind === "permission" ? { kind: "permission", requestId: event.requestId, decision: "deny" } : undefined,
        );
        expect(events.find((event) => event.kind === "permission")).toMatchObject({ toolName: "Bash" });
        expect(said(events)).toBe("permission:deny");
    });

    test("a yes once is the agent's allow-once", async () => {
        const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
        const events = await answering(agent, request("ask-permission", { policy: { permissionMode: "default" } }), (event) =>
            event.kind === "permission" ? { kind: "permission", requestId: event.requestId, decision: "once" } : undefined,
        );
        expect(said(events)).toBe("permission:allow");
    });

    test("a call the rulebook already put to a person is not asked about twice", async () => {
        const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
        const held = heldRequest("ask-to-force-push");
        const events = await answering(agent, { ...held, policy: { ...held.policy, permissionMode: "default" } }, (event) =>
            event.kind === "permission" ? { kind: "permission", requestId: event.requestId, decision: "once" } : undefined,
        );
        expect(events.filter((event) => event.kind === "permission")).toHaveLength(1);
        expect(said(events)).toBe("permission:allow");
    });
});

test("the turn's effort sets the agent's reasoning depth: the tier itself, else the nearest below", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp({ thoughts: ["low", "medium", "high"] }))), TIMEOUTS);
    expect(said(await collect(agent, request("which-thought", { spec: { effort: "medium" } })))).toBe("thought:medium");
    expect(said(await collect(agent, request("which-thought", { spec: { effort: "xhigh" } })))).toBe("thought:high");
});

test("a form the agent asks parks on a question card, and the picks go back as the values its schema named", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
    const events = await answering(agent, request("ask-form"), (event) => {
        if (event.kind !== "question") {
            return undefined;
        }
        const [target, notify] = event.questions;
        return {
            kind: "question",
            requestId: event.requestId,
            answers: { [target?.question ?? ""]: ["Production"], [notify?.question ?? ""]: ["Yes"] },
        };
    });
    const question = events.find((event) => event.kind === "question");
    expect(question).toMatchObject({
        questions: [
            { question: "How should I ship it?\n\nTarget", multiSelect: false, options: [{ label: "Production" }, { label: "Staging" }] },
            { question: "Notify the team", options: [{ label: "Yes" }, { label: "No" }] },
        ],
    });
    expect(said(events)).toBe(`form:${JSON.stringify({ action: "accept", content: { target: "prod", notify: true } })}`);
});

test("a spent allowance in the agent's own words is coded, so the turn is held until it resets", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
    const events = await collect(agent, request("spent-allowance"));
    expect(events).toContainEqual(expect.objectContaining({ kind: "error", code: "rate_limit" }));
});

describe("a command the daemon runs for the agent passes the owner's rulebook first", () => {
    test("a held command is put to a person, and their no refuses the terminal", async () => {
        const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
        const events = await answering(agent, heldRequest("run-terminal"), (event) =>
            event.kind === "permission" ? { kind: "permission", requestId: event.requestId, decision: "deny" } : undefined,
        );
        expect(events.find((event) => event.kind === "permission")).toMatchObject({ program: { text: "git push --force origin main" } });
        expect(said(events)).toBe("terminal:refused");
    });

    test("a command the agent already asked permission for is not asked about again when it runs", async () => {
        const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
        const events = await answering(agent, heldRequest("ask-then-run"), (event) =>
            event.kind === "permission" ? { kind: "permission", requestId: event.requestId, decision: "once" } : undefined,
        );
        expect(events.filter((event) => event.kind === "permission")).toHaveLength(1);
        expect(said(events)).toBe("terminal:term-1");
    });
});

// The turn's door mounts (the daemon's own servers among them) as the agent is handed them at session/new.
const DOOR_URL = "http://127.0.0.1:8787/mcp/ui";
const DOOR = [{ name: "ui", url: DOOR_URL, token: "lease" }];

const offeredServers = async (connection: AcpConnection): Promise<McpServer[] | undefined> => {
    const asked = jest.spyOn(connection.agent, "request");
    const agent = createAcpAgent(connectionsOf(connection), TIMEOUTS);
    await collect(agent, { ...request("hello"), tools: { remote: DOOR } });
    const opened = asked.mock.calls.find(([method]) => method === "session/new");
    // SAFETY: session/new's params are a NewSessionRequest, whose mcpServers the adapter built.
    return (opened?.[1] as NewSessionRequest | undefined)?.mcpServers;
};

test("an agent that advertises http MCP is handed the door's mounts over http, with the turn's bearer", async () => {
    const servers = await offeredServers(fakeAcpConnection(fakeAcpAgentApp(), { loadSession: false, mcpCapabilities: { http: true } }));
    expect(servers).toEqual([{ type: "http", name: "ui", url: DOOR_URL, headers: [{ name: "Authorization", value: "Bearer lease" }] }]);
});

test("an agent with no http MCP is handed the same mounts as stdio servers through the daemon's proxy", async () => {
    const servers = await offeredServers(fakeAcpConnection(fakeAcpAgentApp()));
    expect(servers).toEqual([
        {
            name: "ui",
            command: process.execPath,
            args: [expect.stringMatching(/mcp-proxy\.mjs$/)],
            env: [
                { name: PROXY_URL_ENV, value: DOOR_URL },
                { name: PROXY_BEARER_ENV, value: "lease" },
            ],
        },
    ]);
});

test("a frame a daemon tool raised reaches the turn's stream once the phase attaches, and the gate is there while it runs", async () => {
    const relay = createTurnRelay();
    relay.push({ kind: "agent_notice", level: "info", text: "from a door tool" });
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
    const events = await collect(agent, { ...request("hello"), hooks: { cards, relay } });
    expect(events).toContainEqual({ kind: "agent_notice", level: "info", text: "from a door tool" });
    // Detached with the phase: nothing is left to consult once the turn is over.
    expect(relay.guard()).toBeUndefined();
});

// An agent that reads per-session switches off session/new's `_meta` (Grok Build's `askUserQuestion`) gets the launch's
// own, on every session the turn opens.
test("a launch's session meta rides session/new", async () => {
    const seen: (AcpSessionMeta | undefined)[] = [];
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp({ sessionMeta: (meta) => seen.push(meta) }))), TIMEOUTS);
    const events: AgentEvent[] = [];
    for await (const event of agent("fake", { ...LAUNCH, sessionMeta: { askUserQuestion: false } }, request("hello"))) {
        events.push(event);
    }
    expect(events.at(-1)).toEqual({ kind: "done" });
    expect(seen).toEqual([{ askUserQuestion: false }]);
});
