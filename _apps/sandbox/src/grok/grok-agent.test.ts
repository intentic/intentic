import type { Event } from "@opencode-ai/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { resolvePlanDecision } from "../agent/agent-requests.js";
import { createGrokAgent, createGrokRunner, type GrokRunner, type GrokTurn } from "./grok-agent.js";
import type { OpenCodeService } from "./opencode.js";

// A fake runner yielding one canned OpenCode Event list per invocation (plan turns invoke it repeatedly),
// capturing each turn's prompt/session/agent/model — no server, no network. The production runner does the
// session filtering; the fake yields one session's events directly.
const fakeRunner = (...turns: unknown[][]): { runner: GrokRunner; calls: GrokTurn[] } => {
    const calls: GrokTurn[] = [];
    const runner: GrokRunner = async function* (turn) {
        calls.push(turn);
        yield* (turns[Math.min(calls.length - 1, turns.length - 1)] ?? []) as Event[];
    };
    return { runner, calls };
};

const request = { prompt: "add a /ping route", cwd: "/work", signal: new AbortController().signal };

// Collect all events; `onPlan` schedules a decision for each plan frame AFTER the generator parks on the
// pending-plan bridge (the yield suspends before wait() registers, hence the macrotask).
const collect = async (
    agent: ReturnType<typeof createGrokAgent>,
    turnRequest: Parameters<ReturnType<typeof createGrokAgent>>[0],
    onPlan?: (decisionId: string) => { approve: boolean; feedback?: string },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent(turnRequest)) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan(event.decisionId);
            setTimeout(() => resolvePlanDecision(event.decisionId, decision), 0);
        }
    }
    return events;
};

test("a turn maps OpenCode events onto session, thinking, tools, todos, deltas, and done", async () => {
    const { runner } = fakeRunner([
        { type: "session.created", properties: { info: { id: "s1" } } },
        {
            type: "message.part.updated",
            properties: { part: { type: "reasoning", id: "r1", sessionID: "s1", messageID: "m1", text: "planning the edit", time: { start: 0 } } },
        },
        {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    id: "tp1",
                    sessionID: "s1",
                    messageID: "m1",
                    callID: "c1",
                    tool: "bash",
                    state: { status: "running", input: { command: "pnpm test" }, time: { start: 0 } },
                },
            },
        },
        {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    id: "tp1",
                    sessionID: "s1",
                    messageID: "m1",
                    callID: "c1",
                    tool: "bash",
                    state: {
                        status: "completed",
                        input: { command: "pnpm test" },
                        output: "1 passed",
                        title: "pnpm test",
                        metadata: {},
                        time: { start: 0, end: 1 },
                    },
                },
            },
        },
        { type: "todo.updated", properties: { sessionID: "s1", todos: [{ content: "add route", status: "pending", priority: "high", id: "t1" }] } },
        {
            type: "message.part.updated",
            properties: { part: { type: "text", id: "tx1", sessionID: "s1", messageID: "m1", text: "Added the route." } },
        },
        {
            type: "message.updated",
            properties: {
                info: {
                    id: "m1",
                    sessionID: "s1",
                    role: "assistant",
                    time: { created: 0, completed: 1 },
                    cost: 0.02,
                    tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 800, write: 120 } },
                },
            },
        },
        { type: "session.idle", properties: { sessionID: "s1" } },
    ]);
    const events = await collect(createGrokAgent(runner), request);
    expect(events).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "thinking", text: "planning the edit" },
        { kind: "tool", id: "c1", name: "Bash", target: "pnpm test" },
        { kind: "tool_result", id: "c1", output: "1 passed" },
        { kind: "todos", items: [{ content: "add route", status: "pending" }] },
        { kind: "delta", text: "Added the route." },
        { kind: "usage", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, cacheCreationTokens: 120, costUsd: 0.02 },
        { kind: "done" },
    ]);
});

test("a build turn resumes the session on the xai provider, passes the model, and folds attachments into the prompt", async () => {
    const { runner, calls } = fakeRunner([]);
    await collect(createGrokAgent(runner), {
        ...request,
        sessionId: "s9",
        model: "grok-4.20-0309-non-reasoning",
        attachments: ["/work/.intentic/attachments/a/report.pdf"],
    });
    expect(calls).toHaveLength(1);
    const turn = calls[0]!;
    expect(turn.sessionId).toBe("s9");
    expect(turn.model).toBe("grok-4.20-0309-non-reasoning");
    expect(turn.agent).toBe("build");
    expect(turn.prompt).toContain("/work/.intentic/attachments/a/report.pdf");
});

test("a failing tool surfaces its error as an error tool result", async () => {
    const { runner } = fakeRunner([
        {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    id: "tp1",
                    sessionID: "s1",
                    messageID: "m1",
                    callID: "c1",
                    tool: "bash",
                    state: { status: "error", input: { command: "pnpm test" }, error: "1 failed", time: { start: 0, end: 1 } },
                },
            },
        },
        { type: "session.idle", properties: { sessionID: "s1" } },
    ]);
    const events = await collect(createGrokAgent(runner), request);
    expect(events).toEqual([
        { kind: "tool", id: "c1", name: "Bash", target: "pnpm test" },
        { kind: "tool_result", id: "c1", output: "1 failed", isError: true },
        { kind: "done" },
    ]);
});

test("a plan turn proposes read-only on the plan agent, then executes on build after approval", async () => {
    const { runner, calls } = fakeRunner(
        [
            { type: "session.created", properties: { info: { id: "s2" } } },
            {
                type: "message.part.updated",
                properties: { part: { type: "text", id: "p1", sessionID: "s2", messageID: "m1", text: "Plan: add the route, then test." } },
            },
            { type: "session.idle", properties: { sessionID: "s2" } },
        ],
        [
            { type: "message.part.updated", properties: { part: { type: "text", id: "p2", sessionID: "s2", messageID: "m2", text: "Done." } } },
            { type: "session.idle", properties: { sessionID: "s2" } },
        ],
    );
    const events = await collect(createGrokAgent(runner), { ...request, plan: true }, () => ({ approve: true }));

    expect(events).toEqual([
        { kind: "session", sessionId: "s2" },
        { kind: "plan", decisionId: expect.any(String) as string, text: "Plan: add the route, then test." },
        { kind: "delta", text: "Done." },
        { kind: "done" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.agent).toBe("plan");
    expect(calls[0]!.prompt).toContain("add a /ping route");
    expect(calls[1]!.agent).toBe("build");
    expect(calls[1]!.sessionId).toBe("s2");
});

test("a rejected plan loops another read-only planning turn carrying the feedback", async () => {
    const { runner, calls } = fakeRunner(
        [
            { type: "session.created", properties: { info: { id: "s3" } } },
            { type: "message.part.updated", properties: { part: { type: "text", id: "p1", sessionID: "s3", messageID: "m1", text: "Plan v1" } } },
            { type: "session.idle", properties: { sessionID: "s3" } },
        ],
        [
            { type: "message.part.updated", properties: { part: { type: "text", id: "p2", sessionID: "s3", messageID: "m2", text: "Plan v2" } } },
            { type: "session.idle", properties: { sessionID: "s3" } },
        ],
        [
            { type: "message.part.updated", properties: { part: { type: "text", id: "p3", sessionID: "s3", messageID: "m3", text: "Executed." } } },
            { type: "session.idle", properties: { sessionID: "s3" } },
        ],
    );
    let planCount = 0;
    const events = await collect(createGrokAgent(runner), { ...request, plan: true }, () => {
        planCount += 1;
        return planCount === 1 ? { approve: false, feedback: "use fastify" } : { approve: true };
    });

    expect(events.filter((event) => event.kind === "plan").map((event) => (event as { text: string }).text)).toEqual(["Plan v1", "Plan v2"]);
    expect(events.at(-2)).toEqual({ kind: "delta", text: "Executed." });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.prompt).toContain("use fastify");
    expect(calls[1]!.agent).toBe("plan");
    expect(calls[1]!.sessionId).toBe("s3");
});

test("a session error and a thrown runner become error events followed by done", async () => {
    const failing = fakeRunner([
        { type: "session.error", properties: { sessionID: "s1", error: { name: "UnknownError", data: { message: "xai auth rejected" } } } },
        { type: "session.idle", properties: { sessionID: "s1" } },
    ]);
    // A plain (non-model) error stays uncoded.
    expect(await collect(createGrokAgent(failing.runner), request)).toEqual([{ kind: "error", message: "xai auth rejected" }, { kind: "done" }]);

    // A model-not-found error is tagged so the client reloads the live catalog and drops the bad pinned model.
    const badModel = fakeRunner([
        {
            type: "session.error",
            properties: {
                sessionID: "s1",
                error: { name: "ProviderModelNotFoundError", data: { message: "Model not found: xai/grok-code-fast-1. Did you mean: grok-4.20-0309-reasoning?" } },
            },
        },
        { type: "session.idle", properties: { sessionID: "s1" } },
    ]);
    expect(await collect(createGrokAgent(badModel.runner), request)).toEqual([
        { kind: "error", code: "grok-model-invalid", message: "Model not found: xai/grok-code-fast-1. Did you mean: grok-4.20-0309-reasoning?" },
        { kind: "done" },
    ]);

    const throwing: GrokRunner = async function* () {
        yield { type: "session.created", properties: { info: { id: "s4" } } } as Event;
        throw new Error("opencode server blew up");
    };
    expect(await collect(createGrokAgent(throwing), request)).toEqual([
        { kind: "session", sessionId: "s4" },
        { kind: "error", message: "opencode server blew up" },
        { kind: "done" },
    ]);
});

// A fake OpenCode whose SSE stream yields `events` then STAYS OPEN (like the real global subscription) — so
// these exercise how createGrokRunner terminates against an open stream (idle/error/timeout), which a fake
// GrokRunner (a finite array) can't reproduce. `return()` releases the hang so the runner's cleanup never blocks.
const fakeOpenCode = (events: Event[]): { openCode: OpenCodeService; aborted: () => boolean } => {
    let aborted = false;
    let releaseHang: (() => void) | undefined;
    const stream = {
        [Symbol.asyncIterator]() {
            let i = 0;
            let closed = false;
            return {
                next(): Promise<IteratorResult<Event>> {
                    if (closed) return Promise.resolve({ done: true, value: undefined as never });
                    if (i < events.length) return Promise.resolve({ done: false, value: events[i++]! });
                    return new Promise<IteratorResult<Event>>((resolve) => {
                        releaseHang = () => resolve({ done: true, value: undefined as never });
                    });
                },
                return(): Promise<IteratorResult<Event>> {
                    closed = true;
                    releaseHang?.();
                    return Promise.resolve({ done: true, value: undefined as never });
                },
            };
        },
    };
    const client = {
        event: { subscribe: async () => ({ stream }) },
        session: {
            create: async () => ({ data: { id: "s1" } }),
            promptAsync: async () => ({}),
            abort: async () => {
                aborted = true;
                return {};
            },
        },
    };
    return { openCode: { client: async () => client } as unknown as OpenCodeService, aborted: () => aborted };
};

const runnerTurn: GrokTurn = { prompt: "hi", cwd: "/work", agent: "build", signal: new AbortController().signal };

test("createGrokRunner ends the turn on session.error even while the stream stays open", async () => {
    const { openCode } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        { type: "session.error", properties: { sessionID: "s1", error: { name: "X", data: { message: "boom" } } } } as unknown as Event,
    ]);
    const seen: string[] = [];
    for await (const event of createGrokRunner(openCode)(runnerTurn)) {
        seen.push(event.type);
    }
    expect(seen).toEqual(["session.created", "session.error"]);
});

test("createGrokRunner aborts and throws when no event arrives within the inactivity window", async () => {
    const { openCode, aborted } = fakeOpenCode([{ type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event]);
    const drain = async (): Promise<void> => {
        for await (const event of createGrokRunner(openCode, 20)(runnerTurn)) {
            void event;
        }
    };
    await expect(drain()).rejects.toThrow(/timed out/);
    expect(aborted()).toBe(true);
});
