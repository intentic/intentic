import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { Event } from "@opencode-ai/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { resolveRequest } from "../../agent/tools/agent-requests.js";
import { createGrokAgent, createGrokRunner, type GrokRunner, type GrokTurn } from "./grok-agent.js";
import type { OpenCodeService } from "./opencode.js";

// Fake runner yielding one canned Event list per invocation (plan turns call it repeatedly), capturing each turn's
// fields; no session filtering, unlike the production runner.
const fakeRunner = (...turns: unknown[][]): { runner: GrokRunner; calls: GrokTurn[] } => {
    const calls: GrokTurn[] = [];
    const runner: GrokRunner = async function* (turn) {
        calls.push(turn);
        yield* (turns[Math.min(calls.length - 1, turns.length - 1)] ?? []) as Event[];
    };
    return { runner, calls };
};

const request = { prompt: "add a /ping route", cwd: WORKSPACE_ROOT, signal: new AbortController().signal };

// Collects all events; `onPlan` resolves via `setTimeout` since the generator's yield suspends before the pending-plan
// bridge's `wait()` registers.
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
        attachments: [`${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/attachments/a/report.pdf`],
    });
    expect(calls).toHaveLength(1);
    const turn = calls[0]!;
    expect(turn.sessionId).toBe("s9");
    expect(turn.model).toBe("grok-4.20-0309-non-reasoning");
    expect(turn.agent).toBe("build");
    expect(turn.prompt).toContain("/work/.intentic/records/artifacts/attachments/a/report.pdf");
    expect(turn.images).toBeUndefined();
});

// Image-attachment tests live in grok-agent.integration.test.ts, which needs real files on disk.

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
    // OpenCode broadcasts the echoed user prompt on the same session stream; a text part carries no role, so role is
    // tracked via message.updated.
    const { runner } = fakeRunner(
        [
            { type: "session.created", properties: { info: { id: "s5" } } },
            // user message + text part: the echoed prompt, role recorded then skipped
            { type: "message.updated", properties: { info: { id: "mu", sessionID: "s5", role: "user" } } },
            {
                type: "message.part.updated",
                properties: {
                    part: { type: "text", id: "up1", sessionID: "s5", messageID: "mu", text: "Before making any changes… add a /ping route" },
                },
            },
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
    // plain error stays uncoded
    expect(await collect(createGrokAgent(failing.runner), request)).toEqual([{ kind: "error", message: "xai auth rejected" }, { kind: "done" }]);

    // model-not-found is tagged so the client reloads the catalog and drops the pinned model
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

test("a spent allowance is coded rate_limit, whatever wording the provider refuses in", async () => {
    const refusal = (message: string): unknown[][] => [
        [
            { type: "session.error", properties: { sessionID: "s1", error: { name: "APICallError", data: { message } } } },
            { type: "session.idle", properties: { sessionID: "s1" } },
        ],
    ];
    // Google's own wording, as CLIProxyAPI relays it once its account fleet is exhausted.
    const google = "429 RESOURCE_EXHAUSTED: You exceeded your current quota for gemini models";
    expect(await collect(createGrokAgent(fakeRunner(...refusal(google)).runner), request)).toEqual([
        { kind: "error", code: "rate_limit", message: google },
        { kind: "done" },
    ]);
    // bare rate-limit wording, reached only after OpenCode's own in-turn retries are spent
    const bare = "Rate limit exceeded, please try again later";
    expect(await collect(createGrokAgent(fakeRunner(...refusal(bare)).runner), request)).toEqual([
        { kind: "error", code: "rate_limit", message: bare },
        { kind: "done" },
    ]);
    // An ordinary failure stays uncoded.
    expect(await collect(createGrokAgent(fakeRunner(...refusal("connection reset")).runner), request)).toEqual([
        { kind: "error", message: "connection reset" },
        { kind: "done" },
    ]);
    // A parameter this sandbox never sent, refused upstream; coded as an outage rather than a bad model pick, since "on
    // this model" would otherwise cost a pinned model that wasn't at fault.
    const unsent = "400 prompt_cache_retention is not supported on this model";
    const failure = (await collect(createGrokAgent(fakeRunner(...refusal(unsent)).runner), request)).find((event) => event.kind === "error") as
        { code?: string; message: string } | undefined;
    expect(failure?.code).toBe("provider-outage");
    expect(failure?.message).toContain(unsent);
});

test("an in-turn retry surfaces as provider_retry, naming a rate limit when that is what it is", async () => {
    const next = Date.now() + 42_000;
    const { runner } = fakeRunner([
        { type: "session.created", properties: { info: { id: "s1" } } },
        { type: "session.status", properties: { sessionID: "s1", status: { type: "retry", attempt: 2, message: "429 quota exceeded", next } } },
        { type: "session.status", properties: { sessionID: "s1", status: { type: "retry", attempt: 3, message: "socket hang up", next } } },
        // Every other status event is liveness only; nothing surfaces from it.
        { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } },
        { type: "session.idle", properties: { sessionID: "s1" } },
    ]);
    expect(await collect(createGrokAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "provider_retry", attempt: 2, nextAttemptAt: next, status: 429 },
        { kind: "provider_retry", attempt: 3, nextAttemptAt: next },
        { kind: "done" },
    ]);
});

// Fake OpenCode whose SSE stream stays open after `events` (like the real global subscription), so tests can exercise
// idle/error/timeout termination; `closes` simulates the server ending the stream instead.
const fakeOpenCode = (
    events: Event[],
    rejectModel?: { id: string; message: string },
    closes = false,
): {
    openCode: OpenCodeService;
    aborted: () => boolean;
    recorded: string[][];
    prompts: (string | undefined)[];
    systems: (string | undefined)[];
    // Directories the turn subscribed and registered a watcher for; asserted because a mis-scoped subscription fails
    // silently.
    scopes: { subscribed: string[]; watched: string[] };
    // "read" / "create", in the order they happened.
    order: string[];
} => {
    let aborted = false;
    let releaseHang: (() => void) | undefined;
    // Model ids each promptAsync fired with (self-heal path).
    const prompts: (string | undefined)[] = [];
    // System instructions each message carried, proving `instructions: "append"` isn't dropped.
    const systems: (string | undefined)[] = [];
    const recorded: string[][] = [];
    // Mimics the real stream's opening `server.connected`, which the runner awaits before creating a session.
    const withHello: Event[] = [{ type: "server.connected", properties: {} } as unknown as Event, ...events];
    const stream = {
        [Symbol.asyncIterator]() {
            let i = 0;
            let closed = false;
            return {
                next(): Promise<IteratorResult<Event>> {
                    if (order[0] === undefined) {
                        order.push("read");
                    }
                    if (closed) {
                        return Promise.resolve({ done: true, value: undefined as never });
                    }
                    if (i < withHello.length) {
                        return Promise.resolve({ done: false, value: withHello[i++]! });
                    }
                    if (closes) {
                        return Promise.resolve({ done: true, value: undefined as never });
                    }
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
            promptAsync: async (options: { body?: { model?: { modelID?: string }; system?: string } }) => {
                const modelID = options.body?.model?.modelID;
                prompts.push(modelID);
                systems.push(options.body?.system);
                // Mimics xAI rejecting an unknown model id via a thrown error rather than a session.error event
                // (initial-send path).
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
    // subscribe() opens the stream only on first read; reading after session creation misses `session.created`.
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
    return { openCode: openCode as unknown as OpenCodeService, aborted: () => aborted, recorded, prompts, systems, scopes, order };
};

const runnerTurn: GrokTurn = { prompt: "hi", cwd: WORKSPACE_ROOT, agent: "build", signal: new AbortController().signal };

// An unscoped subscription still connects and heartbeats but carries no session events, so this is asserted on the
// call, not on the emitted frames.
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
    // Boot only knows the workspace root; an isolated turn's worktree is watched because the turn itself registers it.
    expect(scopes.watched).toEqual([worktree]);
});

// `subscribe()` returns a lazy generator; the HTTP request isn't made until the first read, so reading must happen
// before the session is created.
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
    expect(seen).toEqual(["session.created", "session.idle"]);
});

// The runtime is shared: `intentic-gemini` is the same adapter serving Google, so a failure message must name the
// backend actually picked.
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
    const geminiMessage = await stalled("intentic-gemini").catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    const grokMessage = await stalled(undefined).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(geminiMessage).toMatch(/Google/);
    expect(grokMessage).toMatch(/Grok/);
    expect(geminiMessage).toContain("OpenCode");
    expect(grokMessage).toContain("OpenCode");
    expect(geminiMessage).not.toBe(grokMessage);
});

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

// session.idle and session.error are the only two endings a turn has; the stream ending without either means the shared
// opencode serve went away.
test("a stream that ends without ending the turn is the server going away, not a finished turn", async () => {
    const { openCode } = fakeOpenCode(
        [
            { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
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
            } as unknown as Event,
        ],
        undefined,
        true,
    );
    const events = await collect(createGrokAgent(createGrokRunner(openCode), "intentic-gemini"), request);
    // Every turn ends with `done`, even a failed one; the tool call is left in_progress, which is the truth.
    expect(events.map((event) => event.kind)).toEqual(["session", "tool_call", "error", "done"]);
    expect(events[2]).toMatchObject({ message: "Google stopped sending events before the turn ended." });
});

// Stop aborts the session, which ends this same stream; must not be reported as a provider failure.
test("a stream that ends because the turn was stopped is not reported as a failure", async () => {
    const { openCode } = fakeOpenCode([{ type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event], undefined, true);
    const controller = new AbortController();
    controller.abort();
    const seen: string[] = [];
    for await (const event of createGrokRunner(openCode)({ ...runnerTurn, signal: controller.signal })) {
        seen.push(event.type);
    }
    expect(seen).toEqual(["session.created"]);
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

// A Stop before the session exists reaches an already-aborted signal, which a fresh listener never fires on; asserted
// on the call since the turn ends the same way either way.
test("a turn stopped before its session existed still tells OpenCode to abort it", async () => {
    const { openCode, aborted } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event,
    ]);
    const controller = new AbortController();
    controller.abort();

    for await (const event of createGrokRunner(openCode)({ ...runnerTurn, signal: controller.signal })) {
        void event;
    }

    expect(aborted()).toBe(true);
});

test("a retry's announced next attempt pushes the inactivity deadline past it", async () => {
    const { openCode, aborted } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        {
            type: "session.status",
            properties: { sessionID: "s1", status: { type: "retry", attempt: 1, message: "429", next: Date.now() + 150 } },
        } as unknown as Event,
    ]);
    const seen: string[] = [];
    const startedAt = Date.now();
    // The stream stays quiet after the retry, so the turn does die; asserting >= 150ms (vs. the 20ms window) proves the
    // promised wait was honoured, not just slow.
    await expect(
        (async () => {
            for await (const event of createGrokRunner(openCode, 20)(runnerTurn)) {
                seen.push(event.type);
            }
        })(),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(aborted()).toBe(true);
    expect(seen).toEqual(["session.created", "session.status"]);
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
        // the corrected turn (same session) streams normally after the silent re-prompt
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
        // the stale idle from the failed prompt, must not end the turn early
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
    expect(seen).toEqual(["session.created", "session.error"]);
    expect(recorded).toEqual([]);
    expect(prompts).toEqual(["grok-x"]);
});

test("createGrokRunner self-heals a model-not-found REJECTION from the initial prompt (thrown, not a session.error event)", async () => {
    // promptAsync rejects a bad model as a thrown error (outside the event loop), not a session.error; must self-heal
    // identically.
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
    expect(seen).toEqual(["session.created", "message.part.updated", "session.idle"]);
    expect(recorded).toEqual([["grok-4.3"]]);
    expect(prompts).toEqual(["grok-4", "grok-4.3"]);
});

test("a thrown model-not-found with no named alternatives surfaces as a tagged grok-model-invalid error", async () => {
    // No named alternatives means no self-heal; tagged for parity with the event path so the client reloads the
    // catalog.
    const { openCode, recorded, prompts } = fakeOpenCode([], { id: "grok-x", message: "Model not found: xai/grok-x." });
    const events = await collect(createGrokAgent(createGrokRunner(openCode)), { ...request, model: "grok-x" });
    const error = events.find((event) => event.kind === "error") as { code?: string; message: string } | undefined;
    expect(error?.code).toBe("grok-model-invalid");
    expect(error?.message).toContain("grok-x");
    expect(events.at(-1)).toEqual({ kind: "done" });
    expect(recorded).toEqual([]);
    expect(prompts).toEqual(["grok-x"]);
});

// OpenCode takes `system` per message, not per session, so the assertion is per message.
test("the turn's standing instructions ride the prompt body", async () => {
    const { openCode, systems } = fakeOpenCode([{ type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event]);

    await collect(createGrokAgent(createGrokRunner(openCode)), { ...request, systemAppend: "House rules: be brief." });

    expect(systems).toEqual(["House rules: be brief."]);
});

// An empty system message is not the same request as no message; OpenCode's own prompt should stand.
test("nothing to say sends no system field", async () => {
    const { openCode, systems } = fakeOpenCode([{ type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event]);

    await collect(createGrokAgent(createGrokRunner(openCode)), request);

    expect(systems).toEqual([undefined]);
});

// Both plan and execute phases must carry the same instructions; propose-then-execute must not drop them for the second
// message.
test("a planned turn carries the same instructions into its execute phase", async () => {
    const { runner, calls } = fakeRunner(
        [
            { type: "session.created", properties: { info: { id: "s9" } } },
            { type: "message.part.updated", properties: { part: { type: "text", id: "p1", sessionID: "s9", messageID: "m1", text: "Plan." } } },
            { type: "session.idle", properties: { sessionID: "s9" } },
        ],
        [
            { type: "message.part.updated", properties: { part: { type: "text", id: "p2", sessionID: "s9", messageID: "m2", text: "Done." } } },
            { type: "session.idle", properties: { sessionID: "s9" } },
        ],
    );

    await collect(createGrokAgent(runner), { ...request, permissionMode: "plan" as const, systemAppend: "House rules: be brief." }, () => ({
        approve: true,
    }));

    expect(calls.map((call) => call.system)).toEqual(["House rules: be brief.", "House rules: be brief."]);
});
