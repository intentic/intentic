import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AcpAgentConfig, AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { resolveRequest } from "../agent/agent-requests.js";
import type { AgentRequest } from "../agent/agent.js";
import { fakeAcpAgentApp, fakeAcpConnection } from "./__fixtures__/fake-acp-agent.js";
import { type AcpTimeouts, createAcpAgent } from "./acp-agent.js";
import type { AcpConnection, AcpConnections } from "./acp-connection.js";

// The adapter under test is the real one; only the connection is the in-process fixture (no spawn).
const connectionsOf = (connection: AcpConnection): AcpConnections => ({
    acquire: async () => connection,
    drop: () => {},
});

const CONFIG: AcpAgentConfig = { command: "fake acp" };
const TIMEOUTS: AcpTimeouts = { inactivityMs: 60_000, maxTurnMs: 60_000 };

const request = (prompt: string, overrides: Partial<AgentRequest> = {}): AgentRequest => ({
    prompt,
    cwd: WORKSPACE_ROOT,
    signal: new AbortController().signal,
    ...overrides,
});

const collect = async (
    agent: ReturnType<typeof createAcpAgent>,
    turnRequest: AgentRequest,
    onPlan?: (requestId: string) => { approve: boolean; feedback?: string },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent("fake", CONFIG, turnRequest)) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan(event.requestId);
            setTimeout(() => resolveRequest({ kind: "plan", requestId: event.requestId, ...decision }), 0);
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

test("a stalled agent trips the inactivity watchdog: cancel, kill, error, done", async () => {
    const connection = fakeAcpConnection(fakeAcpAgentApp());
    const agent = createAcpAgent(connectionsOf(connection), { inactivityMs: 100, maxTurnMs: 60_000 });
    const events = await collect(agent, request("stall forever"));
    const error = events.find((event) => event.kind === "error");
    expect(error?.kind === "error" && error.message.includes("timed out")).toBe(true);
    expect(connection.alive()).toBe(false);
    expect(events.at(-1)).toEqual({ kind: "done" });
});

test("resuming a session the process doesn't know without loadSession self-heals via session-not-found", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
    const events = await collect(agent, request("hello", { sessionId: "stale-id" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "error", code: "session-not-found" }));
    expect(events.at(-1)).toEqual({ kind: "done" });
});

test("plan mode runs the two-phase emulation: captured plan → approval → execute on the same session", async () => {
    const agent = createAcpAgent(connectionsOf(fakeAcpConnection(fakeAcpAgentApp())), TIMEOUTS);
    const events = await collect(agent, request("plan the work", { permissionMode: "plan" as const }), () => ({ approve: true }));
    const plan = events.find((event) => event.kind === "plan");
    expect(plan?.kind === "plan" && plan.text).toBe("1. do the thing");
    expect(events).toContainEqual({ kind: "delta", text: "executed" });
    expect(events.at(-1)).toEqual({ kind: "done" });
});
