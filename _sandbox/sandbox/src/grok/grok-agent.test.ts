import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { Event } from "@opencode-ai/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { resolveRequest } from "../agent/agent-requests.js";
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

const request = { prompt: "add a /ping route", cwd: WORKSPACE_ROOT, signal: new AbortController().signal };

// Collect all events; `onPlan` schedules a decision for each plan frame AFTER the generator parks on the
// pending-plan bridge (the yield suspends before wait() registers, hence the macrotask).
const collect = async (
    agent: ReturnType<typeof createGrokAgent>,
    turnRequest: Parameters<ReturnType<typeof createGrokAgent>>[0],
    onPlan?: (requestId: string) => { approve: boolean; feedback?: string },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent(turnRequest)) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan(event.requestId);
            setTimeout(() => resolveRequest({ kind: "plan", requestId: event.requestId, ...decision }), 0);
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
        { kind: "tool_call", id: "c1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
        { kind: "tool_call_update", id: "c1", status: "completed", content: [{ type: "text", text: "1 passed" }] },
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
        attachments: [`${WORKSPACE_ROOT}/${STATE_DIR}/artifacts/attachments/a/report.pdf`],
    });
    expect(calls).toHaveLength(1);
    const turn = calls[0]!;
    expect(turn.sessionId).toBe("s9");
    expect(turn.model).toBe("grok-4.20-0309-non-reasoning");
    expect(turn.agent).toBe("build");
    expect(turn.prompt).toContain("/work/.intentic/artifacts/attachments/a/report.pdf");
});

test("a failing tool first seen at its error state arrives as one whole failed tool_call", async () => {
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
        {
            kind: "tool_call",
            id: "c1",
            name: "Bash",
            category: "execute",
            status: "failed",
            target: "pnpm test",
            content: [{ type: "text", text: "1 failed" }],
        },
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
    const events = await collect(createGrokAgent(runner), { ...request, permissionMode: "plan" as const }, () => ({ approve: true }));

    expect(events).toEqual([
        { kind: "session", sessionId: "s2" },
        { kind: "plan", requestId: expect.any(String) as string, text: "Plan: add the route, then test." },
        // The card's release — the id tells the fleet the turn stopped waiting, and the approval riding with it
        // is what lets a replayed run freeze the card instead of re-offering it.
        {
            kind: "resolved",
            requestId: expect.any(String) as string,
            reply: { kind: "plan", requestId: expect.any(String) as string, approve: true },
        },
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
    const events = await collect(createGrokAgent(runner), { ...request, permissionMode: "plan" as const }, () => {
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

test("a plan turn captures only the assistant's text, never the echoed user prompt", async () => {
    // OpenCode broadcasts the USER message (the echoed prompt) on the SAME session stream as the assistant's, and a
    // text part carries no role — the plan must be the assistant's text alone (regression: prompt leaking into planText).
    const { runner } = fakeRunner(
        [
            { type: "session.created", properties: { info: { id: "s5" } } },
            // The user message + its text part (the prompt echo) — role recorded, then the part is skipped.
            { type: "message.updated", properties: { info: { id: "mu", sessionID: "s5", role: "user" } } },
            {
                type: "message.part.updated",
                properties: {
                    part: { type: "text", id: "up1", sessionID: "s5", messageID: "mu", text: "Before making any changes… add a /ping route" },
                },
            },
            // The assistant's actual plan.
            {
                type: "message.updated",
                properties: {
                    info: {
                        id: "ma",
                        sessionID: "s5",
                        role: "assistant",
                        cost: 0,
                        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                    },
                },
            },
            {
                type: "message.part.updated",
                properties: { part: { type: "text", id: "ap1", sessionID: "s5", messageID: "ma", text: "Plan: add the route." } },
            },
            { type: "session.idle", properties: { sessionID: "s5" } },
        ],
        [{ type: "session.idle", properties: { sessionID: "s5" } }],
    );
    const events = await collect(createGrokAgent(runner), { ...request, permissionMode: "plan" as const }, () => ({ approve: true }));
    const plan = events.find((event) => event.kind === "plan") as { text: string } | undefined;
    expect(plan?.text).toBe("Plan: add the route.");
});

test("a plan turn that errors after partial text emits the error and NO plan frame", async () => {
    // Partial assistant text was captured, then the turn errored (e.g. out of credits) — a failed turn must surface
    // only the error, never a bogus plan built from the partial/echoed text.
    const { runner } = fakeRunner([
        { type: "session.created", properties: { info: { id: "s6" } } },
        {
            type: "message.part.updated",
            properties: { part: { type: "text", id: "ap1", sessionID: "s6", messageID: "ma", text: "Partial plan…" } },
        },
        { type: "session.error", properties: { sessionID: "s6", error: { name: "PaymentRequiredError", data: { message: "Payment Required" } } } },
    ]);
    const events = await collect(createGrokAgent(runner), { ...request, permissionMode: "plan" as const });
    expect(events).toEqual([{ kind: "session", sessionId: "s6" }, { kind: "error", message: "Payment Required" }, { kind: "done" }]);
    expect(events.some((event) => event.kind === "plan")).toBe(false);
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
                error: {
                    name: "ProviderModelNotFoundError",
                    data: { message: "Model not found: xai/grok-code-fast-1. Did you mean: grok-4.20-0309-reasoning?" },
                },
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
const fakeOpenCode = (
    events: Event[],
    rejectModel?: { id: string; message: string },
): {
    openCode: OpenCodeService;
    aborted: () => boolean;
    recorded: string[][];
    prompts: (string | undefined)[];
    // The directories the turn subscribed and registered a delegation watcher for. Both are scoped, and a
    // subscription that loses its scope does not fail — it goes silent — so the scope is asserted, not assumed.
    scopes: { subscribed: string[]; watched: string[] };
    // "read" / "create", in the order they happened — see `order` in the body.
    order: string[];
} => {
    let aborted = false;
    let releaseHang: (() => void) | undefined;
    // Captures for the self-heal path: the model ids each promptAsync fired with, and every recordModels payload.
    const prompts: (string | undefined)[] = [];
    const recorded: string[][] = [];
    /* Every real stream opens with `server.connected`, and the runner AWAITS it — that hello is how it knows the
     * subscription is live before it creates a session whose `session.created` it would otherwise miss. A double
     * that stayed silent would make every turn here pay the connect bound in full, which is a fake being
     * unfaithful rather than a runner being slow. It belongs to no session, so it changes nothing else. */
    const withHello: Event[] = [{ type: "server.connected", properties: {} } as unknown as Event, ...events];
    const stream = {
        [Symbol.asyncIterator]() {
            let i = 0;
            let closed = false;
            return {
                next(): Promise<IteratorResult<Event>> {
                    if (order[0] === undefined) order.push("read");
                    if (closed) return Promise.resolve({ done: true, value: undefined as never });
                    if (i < withHello.length) return Promise.resolve({ done: false, value: withHello[i++]! });
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
            create: async () => {
                order.push("create");
                return { data: { id: "s1" } };
            },
            promptAsync: async (options: { body?: { model?: { modelID?: string } } }) => {
                const modelID = options.body?.model?.modelID;
                prompts.push(modelID);
                // Mimic OpenCode/xAI REJECTING an unknown model id (a thrown ProviderModelNotFoundError, the way
                // the real server does) instead of emitting a session.error event — the initial-send path.
                if (rejectModel !== undefined && modelID === rejectModel.id) {
                    throw new Error(rejectModel.message);
                }
                return {};
            },
            abort: async () => {
                aborted = true;
                return {};
            },
        },
    };
    const scopes = { subscribed: [] as string[], watched: [] as string[] };
    // The order that matters: `subscribe()` only opens the HTTP stream when something reads it, so a first read
    // issued after the session exists misses `session.created` — and with it the id the next message resumes on.
    const order: string[] = [];
    const openCode = {
        client: async () => client,
        events: async (directory: string) => {
            scopes.subscribed.push(directory);
            return { stream };
        },
        watch: async (directory: string) => void scopes.watched.push(directory),
        recordModels: async (ids: string[]) => void recorded.push(ids),
    };
    return { openCode: openCode as unknown as OpenCodeService, aborted: () => aborted, recorded, prompts, scopes, order };
};

const runnerTurn: GrokTurn = { prompt: "hi", cwd: WORKSPACE_ROOT, agent: "build", signal: new AbortController().signal };

/* THE SILENT FAILURE THIS FILE EXISTS TO PREVENT A SECOND TIME.
 *
 * OpenCode's event stream is scoped to one exact directory. Subscribing without one still connects, still
 * answers 200 and still delivers heartbeats — it just carries no session events, so every turn on this runtime
 * watched a stream its own session would never appear on, rode out the inactivity watchdog and died as "timed
 * out waiting for OpenCode" while the turn itself ran to completion upstream and spent the user's allowance.
 *
 * Nothing about that is observable from the frames a turn emits, which is why it is asserted on the CALL. */
test("createGrokRunner subscribes and watches scoped to the turn's own directory", async () => {
    const { openCode, scopes } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event,
    ]);
    const worktree = "/history/worktrees/wise-condor/repo";
    for await (const event of createGrokRunner(openCode)({ ...runnerTurn, cwd: worktree })) {
        void event;
    }
    expect(scopes.subscribed).toEqual([worktree]);
    // The delegation watcher is scoped the same way, and the boot only knows the workspace root — so an isolated
    // turn's worktree is watched because the turn itself registered it.
    expect(scopes.watched).toEqual([worktree]);
});

/* The stream is READ before the session is created, not merely subscribed to.
 *
 * `subscribe()` hands back a lazy generator: the HTTP request is not made until the first read. So subscribing
 * early proves nothing on its own, and a first read issued after the prompt arrives too late for the
 * `session.created` that carries the id every later message in this conversation resumes on. */
test("createGrokRunner opens the stream before the session it must not miss the creation of", async () => {
    const { openCode, order } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event,
    ]);
    const seen: string[] = [];
    for await (const event of createGrokRunner(openCode)(runnerTurn)) {
        seen.push(event.type);
    }
    expect(order).toEqual(["read", "create"]);
    // And the creation still reaches the caller, which is the whole point of reading first.
    expect(seen).toEqual(["session.created", "session.idle"]);
});

// The runtime is shared: `intentic-gemini` is the same adapter serving Google. A user who picked Claude Opus 4.6
// there and hit the watchdog was told "Grok turn timed out", naming a product they had not chosen.
test("a stalled turn is reported against the backend the user actually picked", async () => {
    const stalled = (provider: string | undefined): Promise<void> =>
        (async () => {
            for await (const event of createGrokRunner(
                fakeOpenCode([]).openCode,
                20,
            )({ ...runnerTurn, ...(provider !== undefined ? { provider } : {}) })) {
                void event;
            }
        })();
    await expect(stalled("intentic-gemini")).rejects.toThrow("Google turn timed out waiting for OpenCode.");
    await expect(stalled(undefined)).rejects.toThrow("Grok turn timed out waiting for OpenCode.");
});

// session.status is the only event a model that thinks for minutes before its first token emits. It is not
// consumed anywhere, and it is carried purely so the watchdog counts it as life rather than killing that turn.
test("a session.status keeps the inactivity watchdog alive", async () => {
    const { openCode } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event,
    ]);
    const seen: string[] = [];
    for await (const event of createGrokRunner(openCode)(runnerTurn)) {
        seen.push(event.type);
    }
    expect(seen).toEqual(["session.created", "session.status", "session.idle"]);
});

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

test("createGrokRunner self-heals a model-not-found rejection: records the named models and re-prompts once", async () => {
    const { openCode, recorded, prompts } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        {
            type: "session.error",
            properties: {
                sessionID: "s1",
                error: { name: "ProviderModelNotFoundError", data: { message: "Model not found: xai/grok-4-stale. Did you mean: grok-4-latest?" } },
            },
        } as unknown as Event,
        // The corrected turn (same session) streams normally after the silent re-prompt.
        {
            type: "message.part.updated",
            properties: { part: { type: "text", id: "tx1", sessionID: "s1", messageID: "m1", text: "Fixed." } },
        } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event,
    ]);
    const seen: string[] = [];
    for await (const event of createGrokRunner(openCode)({ ...runnerTurn, model: "grok-4-stale" })) {
        seen.push(event.type);
    }
    // The rejection is swallowed (never yielded) and the turn produces the corrected content instead.
    expect(seen).toEqual(["session.created", "message.part.updated", "session.idle"]);
    expect(recorded).toEqual([["grok-4-latest"]]);
    expect(prompts).toEqual(["grok-4-stale", "grok-4-latest"]);
});

test("createGrokRunner's self-heal ignores a stale idle from the failed prompt, waiting for the corrected turn", async () => {
    const { openCode } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        {
            type: "session.error",
            properties: { sessionID: "s1", error: { data: { message: "Model not found: xai/grok-4-stale. Did you mean: grok-4-latest?" } } },
        } as unknown as Event,
        // A lingering idle from the rejected prompt — must NOT end the turn before the retry streams.
        { type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event,
        {
            type: "message.part.updated",
            properties: { part: { type: "text", id: "tx1", sessionID: "s1", messageID: "m1", text: "Fixed." } },
        } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event,
    ]);
    const seen: string[] = [];
    for await (const event of createGrokRunner(openCode)({ ...runnerTurn, model: "grok-4-stale" })) {
        seen.push(event.type);
    }
    expect(seen).toEqual(["session.created", "message.part.updated", "session.idle"]);
});

test("createGrokRunner surfaces a model error it cannot self-heal (no named alternatives), recording nothing", async () => {
    const { openCode, recorded, prompts } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        { type: "session.error", properties: { sessionID: "s1", error: { data: { message: "Model not found: xai/grok-x." } } } } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event,
    ]);
    const seen: string[] = [];
    for await (const event of createGrokRunner(openCode)({ ...runnerTurn, model: "grok-x" })) {
        seen.push(event.type);
    }
    // No "Did you mean" ⇒ no retry: the error is surfaced (and terminal), and nothing is recorded/re-prompted.
    expect(seen).toEqual(["session.created", "session.error"]);
    expect(recorded).toEqual([]);
    expect(prompts).toEqual(["grok-x"]);
});

test("createGrokRunner self-heals a model-not-found REJECTION from the initial prompt (thrown, not a session.error event)", async () => {
    // The real promptAsync REJECTS on a bad model (a thrown ProviderModelNotFoundError with the SessionPrompt
    // stack) rather than emitting a session.error — and the initial send is OUTSIDE the event loop, so this is the
    // path that surfaced raw in production. It must heal identically: record xAI's named models, re-prompt once.
    const { openCode, recorded, prompts } = fakeOpenCode(
        [
            { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
            {
                type: "message.part.updated",
                properties: { part: { type: "text", id: "tx1", sessionID: "s1", messageID: "m1", text: "Fixed." } },
            } as unknown as Event,
            { type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event,
        ],
        { id: "grok-4", message: "Model not found: xai/grok-4. Did you mean: grok-4.3?" },
    );
    const seen: string[] = [];
    for await (const event of createGrokRunner(openCode)({ ...runnerTurn, model: "grok-4" })) {
        seen.push(event.type);
    }
    // The thrown rejection is swallowed (never surfaced) and the corrected turn's content streams instead.
    expect(seen).toEqual(["session.created", "message.part.updated", "session.idle"]);
    expect(recorded).toEqual([["grok-4.3"]]);
    expect(prompts).toEqual(["grok-4", "grok-4.3"]);
});

test("a thrown model-not-found with no named alternatives surfaces as a tagged grok-model-invalid error", async () => {
    // promptAsync rejects with a model error that names no alternatives, so the runner can't self-heal and
    // re-throws. runGrokAgent must tag it grok-model-invalid (parity with the event path) so the client reloads the
    // catalog + drops the bad pinned model, instead of surfacing the raw stack-trace error.
    const { openCode, recorded, prompts } = fakeOpenCode([], { id: "grok-x", message: "Model not found: xai/grok-x." });
    const events = await collect(createGrokAgent(createGrokRunner(openCode)), { ...request, model: "grok-x" });
    expect(events).toEqual([{ kind: "error", code: "grok-model-invalid", message: "Model not found: xai/grok-x." }, { kind: "done" }]);
    expect(recorded).toEqual([]);
    expect(prompts).toEqual(["grok-x"]);
});
