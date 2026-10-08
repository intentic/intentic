import { HISTORY_ROOT, STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { Event } from "@opencode-ai/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import {
    createOpenCodeAgent,
    createOpenCodeRunner,
    type OpenCodeRunner,
    type OpenCodeTurn,
    type OpenCodeTurnEvent,
    sessionFamily,
} from "./opencode-agent.js";
import { type CommandGuard, consultWith, type GuardOutcome, vendorSubject } from "../../guard/command-guard.js";
import { unstubbed } from "@intentic/testing";
import { opt } from "../../opt.js";
import type { OpenCodeService, SessionJudge } from "./opencode.js";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { mcpServersOf, type OpenCodeMcpServer, openCodeMounts } from "./opencode-mcp.js";
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import { DEFAULT_TURN_TIMEOUTS } from "../decorators/turn-watchdog.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../testing.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

// Fake runner yielding one canned Event list per invocation (plan turns call it repeatedly), capturing each turn's
// fields; no session filtering, unlike the production runner.
const fakeRunner = (...turns: unknown[][]): { runner: OpenCodeRunner; calls: OpenCodeTurn[] } => {
    const calls: OpenCodeTurn[] = [];
    const runner: OpenCodeRunner = async function* (turn) {
        calls.push(turn);
        yield* (turns[Math.min(calls.length - 1, turns.length - 1)] ?? []) as Event[];
    };
    return { runner, calls };
};

const request: AgentRequest<ContainerCredential> = {
    execution: unstubbed("execution", {}),
    spec: { prompt: "add a /ping route", cwd: WORKSPACE_ROOT },
    policy: {},
    tools: {},
    credential: { kind: "container" },
    hooks: { cards },
    signal: new AbortController().signal,
};

// Collects all events; `onPlan` resolves via `setTimeout` since the generator's yield suspends before the pending-plan
// bridge's `wait()` registers.
const collect = async (
    agent: ReturnType<typeof createOpenCodeAgent>,
    turnRequest: Parameters<ReturnType<typeof createOpenCodeAgent>>[0],
    onPlan?: (requestId: string) => { approve: boolean; feedback?: string },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent(turnRequest)) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan(event.requestId);
            setTimeout(() => cards.resolve({ kind: "plan", requestId: event.requestId, ...decision }), 0);
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
    const events = await collect(createOpenCodeAgent(runner), request);
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

// Session events as OpenCode sends them, whole, for the tests that read them typed.
const sessionCreated = (id: string, parentID?: string): Event => ({
    type: "session.created",
    properties: {
        info: {
            id,
            projectID: "p1",
            directory: WORKSPACE_ROOT,
            title: id,
            version: "1.18.32",
            time: { created: 0, updated: 0 },
            ...opt("parentID", parentID),
        },
    },
});
const sessionIdle = (sessionID: string): Event => ({ type: "session.idle", properties: { sessionID } });
const sessionBusy = (sessionID: string): Event => ({ type: "session.status", properties: { sessionID, status: { type: "busy" } } });

// OpenCode's task tool runs a subagent in a child session and names that session on the task's part; the child's own
// events then come on the same stream. Drawn as the Claude loop's are: the subagent on its task's card, its calls,
// prose and spend under that card, its report as the subagent's summary.
test("a task's subagent runs under its card: its session's calls, prose and spend, then its report", async () => {
    const task = (state: object) => ({
        type: "message.part.updated",
        properties: { part: { type: "tool", id: "tp-task", sessionID: "s1", messageID: "m1", callID: "task-1", tool: "task", state } },
    });
    const input = { description: "Map the reads", prompt: "Find every read of users.", subagent_type: "explore" };
    const child = (part: object) => ({ type: "message.part.updated", properties: { part: { sessionID: "child-1", ...part } } });
    const { runner } = fakeRunner([
        { type: "session.created", properties: { info: { id: "s1" } } },
        task({ status: "running", input, time: { start: 0 } }),
        { type: "session.created", properties: { info: { id: "child-1", parentID: "s1" } } },
        // Heard before its task names the session, so held; the prompt the task sent it is the subagent's user message.
        { type: "message.updated", properties: { info: { id: "cm0", sessionID: "child-1", role: "user", time: { created: 0 } } } },
        child({ type: "text", id: "ct0", messageID: "cm0", text: "Find every read of users." }),
        task({ status: "running", input, title: "Map the reads", metadata: { sessionId: "child-1", parentSessionId: "s1" }, time: { start: 0 } }),
        child({
            type: "tool",
            id: "ctp",
            messageID: "cm1",
            callID: "cc1",
            tool: "grep",
            state: { status: "running", input: { pattern: "from(users)" }, time: { start: 0 } },
        }),
        child({
            type: "tool",
            id: "ctp",
            messageID: "cm1",
            callID: "cc1",
            tool: "grep",
            state: {
                status: "completed",
                input: { pattern: "from(users)" },
                output: "api/a.ts:3",
                title: "grep",
                metadata: {},
                time: { start: 0, end: 1 },
            },
        }),
        {
            type: "message.updated",
            properties: {
                info: {
                    id: "cm1",
                    sessionID: "child-1",
                    role: "assistant",
                    time: { created: 0, completed: 1 },
                    cost: 0.01,
                    tokens: { input: 900, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
                },
            },
        },
        child({ type: "text", id: "ct1", messageID: "cm1", text: "Found 7 reads." }),
        { type: "session.idle", properties: { sessionID: "child-1" } },
        task({
            status: "completed",
            input,
            output: `<task id="child-1" state="completed">\n<task_result>\nFound 7 reads.\n</task_result>\n</task>`,
            title: "Map the reads",
            metadata: { sessionId: "child-1" },
            time: { start: 0, end: 2 },
        }),
        { type: "session.idle", properties: { sessionID: "s1" } },
    ]);
    const events = await collect(createOpenCodeAgent(runner), request);
    expect(events).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "tool_call", id: "task-1", name: "Task", category: "other", status: "in_progress" },
        { kind: "subagent", id: "task-1", subagentKind: "subagent", agentType: "explore", description: "Map the reads" },
        { kind: "tool_call", id: "cc1", name: "Grep", category: "search", status: "in_progress", target: "from(users)", parentToolUseId: "task-1" },
        { kind: "subagent_update", id: "task-1", toolUses: 1, lastTool: "Grep" },
        { kind: "tool_call_update", id: "cc1", status: "completed", content: [{ type: "text", text: "api/a.ts:3" }] },
        { kind: "subagent_update", id: "task-1", tokens: 1000 },
        { kind: "delta", text: "Found 7 reads.", parentToolUseId: "task-1" },
        {
            kind: "tool_call_update",
            id: "task-1",
            status: "completed",
            content: [{ type: "text", text: `<task id="child-1" state="completed">\n<task_result>\nFound 7 reads.\n</task_result>\n</task>` }],
        },
        { kind: "subagent_update", id: "task-1", status: "completed", summary: "Found 7 reads." },
        // The subagent's spend is the turn's: the account paid for it.
        { kind: "usage", inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01 },
        { kind: "done" },
    ]);
});

test("a task that fails ends its subagent failed, with OpenCode's own words", async () => {
    const task = (state: object) => ({
        type: "message.part.updated",
        properties: { part: { type: "tool", id: "tp-task", sessionID: "s1", messageID: "m1", callID: "task-2", tool: "task", state } },
    });
    const input = { description: "Port the job", prompt: "…", subagent_type: "general" };
    const { runner } = fakeRunner([
        { type: "session.created", properties: { info: { id: "s1" } } },
        task({ status: "running", input, time: { start: 0 } }),
        task({ status: "error", input, error: "Subagent failed (task_id: child-2): out of credits", time: { start: 0, end: 1 } }),
        { type: "session.idle", properties: { sessionID: "s1" } },
    ]);
    const events = await collect(createOpenCodeAgent(runner), request);
    expect(events.filter((event) => event.kind === "subagent" || event.kind === "subagent_update")).toEqual([
        { kind: "subagent", id: "task-2", subagentKind: "subagent", agentType: "general", description: "Port the job" },
        { kind: "subagent_update", id: "task-2", status: "failed", error: "Subagent failed (task_id: child-2): out of credits" },
    ]);
});

// A subagent's session names its parent; the family is the turn's own session and every session beneath it, and a
// subagent answers to the rules its parent does, released with the turn.
test("a turn's session family takes in its subagents' sessions, gates them as its own, and lets them go together", () => {
    const judge: SessionJudge = { gate: unstubbed<CommandGuard>("gate", {}), push: () => {}, hold: () => () => {} };
    const registered: string[] = [];
    const released: string[] = [];
    const family = sessionFamily("s1", judge, {
        register: (session) => void registered.push(session),
        release: (session) => void released.push(session),
    });

    expect([family.whose(sessionIdle("s1")), family.whose(sessionCreated("child-1", "s1")), family.whose(sessionIdle("child-1"))]).toEqual([
        "own",
        "subagent",
        "subagent",
    ]);
    expect([
        family.whose(sessionCreated("grandchild", "child-1")),
        family.whose(sessionCreated("stranger", "elsewhere")),
        family.whose(sessionIdle("stranger")),
    ]).toEqual(["subagent", undefined, undefined]);
    family.release();
    expect({ registered, released }).toEqual({ registered: ["s1", "child-1", "grandchild"], released: ["s1", "child-1", "grandchild"] });
});

test("createOpenCodeRunner lets its subagents' sessions through and ends only on its own", async () => {
    const { openCode } = fakeOpenCode([
        sessionCreated("s1"),
        sessionCreated("child-1", "s1"),
        sessionBusy("child-1"),
        sessionIdle("child-1"),
        sessionBusy("someone-else"),
        sessionIdle("s1"),
    ]);
    // Which session each event the turn got was about.
    const sessionOf = (event: OpenCodeTurnEvent): string => {
        if (event.type === "session.created") {
            return event.properties.info.id;
        }
        return event.type === "session.idle" || event.type === "session.status" ? event.properties.sessionID : "";
    };
    const seen: string[] = [];
    for await (const event of createOpenCodeRunner(openCode)(runnerTurn)) {
        seen.push(`${event.type}:${sessionOf(event)}`);
    }
    expect(seen).toEqual(["session.created:s1", "session.created:child-1", "session.status:child-1", "session.idle:child-1", "session.idle:s1"]);
});

test("a build turn resumes the session on the xai provider, passes the model, and folds attachments into the prompt", async () => {
    const { runner, calls } = fakeRunner([]);
    await collect(createOpenCodeAgent(runner), {
        ...request,
        spec: {
            ...request.spec,
            sessionId: "s9",
            model: "grok-4.20-0309-non-reasoning",
            attachments: [`${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/attachments/a/report.pdf`],
        },
    });
    expect(calls).toHaveLength(1);
    const turn = calls[0]!;
    expect(turn.sessionId).toBe("s9");
    expect(turn.model).toBe("grok-4.20-0309-non-reasoning");
    expect(turn.agent).toBe("build");
    expect(turn.prompt).toContain("/work/.intentic/records/artifacts/attachments/a/report.pdf");
    expect(turn.images).toBeUndefined();
});

test("a sealed request runs as one build message carrying its own system prompt, not a turn's standing instructions", async () => {
    const { runner, calls } = fakeRunner([]);
    await collect(createOpenCodeAgent(runner, OPENCODE_GEMINI_PROVIDER), {
        ...request,
        spec: { ...request.spec, model: "gemini-3-flash", systemPromptMode: "custom", systemPrompt: "Answer exactly.", systemAppend: "## Delegating" },
        policy: { sealed: true },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ agent: "build", provider: OPENCODE_GEMINI_PROVIDER, model: "gemini-3-flash", system: "Answer exactly.", sealed: true });
});

// Image-attachment tests live in opencode-agent.integration.test.ts, which needs real files on disk.

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
    const events = await collect(createOpenCodeAgent(runner), request);
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
    const events = await collect(createOpenCodeAgent(runner), { ...request, policy: { ...request.policy, permissionMode: "plan" as const } }, () => ({
        approve: true,
    }));

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
    const events = await collect(createOpenCodeAgent(runner), { ...request, policy: { ...request.policy, permissionMode: "plan" as const } }, () => {
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
    const events = await collect(createOpenCodeAgent(runner), { ...request, policy: { ...request.policy, permissionMode: "plan" as const } }, () => ({
        approve: true,
    }));
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
    const events = await collect(createOpenCodeAgent(runner), { ...request, policy: { ...request.policy, permissionMode: "plan" as const } });
    expect(events).toEqual([{ kind: "session", sessionId: "s6" }, { kind: "error", message: "Payment Required" }, { kind: "done" }]);
    expect(events.some((event) => event.kind === "plan")).toBe(false);
});

test("a session error and a thrown runner become error events followed by done", async () => {
    const failing = fakeRunner([
        { type: "session.error", properties: { sessionID: "s1", error: { name: "UnknownError", data: { message: "xai auth rejected" } } } },
        { type: "session.idle", properties: { sessionID: "s1" } },
    ]);
    // plain error stays uncoded
    expect(await collect(createOpenCodeAgent(failing.runner), request)).toEqual([{ kind: "error", message: "xai auth rejected" }, { kind: "done" }]);

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
    expect(await collect(createOpenCodeAgent(badModel.runner), request)).toEqual([
        { kind: "error", code: "grok-model-invalid", message: "Model not found: xai/grok-code-fast-1. Did you mean: grok-4.20-0309-reasoning?" },
        { kind: "done" },
    ]);

    const throwing: OpenCodeRunner = async function* () {
        yield { type: "session.created", properties: { info: { id: "s4" } } } as Event;
        throw new Error("opencode server blew up");
    };
    expect(await collect(createOpenCodeAgent(throwing), request)).toEqual([
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
    expect(await collect(createOpenCodeAgent(fakeRunner(...refusal(google)).runner), request)).toEqual([
        { kind: "error", code: "rate_limit", message: google },
        { kind: "done" },
    ]);
    // bare rate-limit wording, reached only after OpenCode's own in-turn retries are spent
    const bare = "Rate limit exceeded, please try again later";
    expect(await collect(createOpenCodeAgent(fakeRunner(...refusal(bare)).runner), request)).toEqual([
        { kind: "error", code: "rate_limit", message: bare },
        { kind: "done" },
    ]);
    // An ordinary failure stays uncoded.
    expect(await collect(createOpenCodeAgent(fakeRunner(...refusal("connection reset")).runner), request)).toEqual([
        { kind: "error", message: "connection reset" },
        { kind: "done" },
    ]);
    // A parameter this sandbox never sent, refused upstream; coded as an outage rather than a bad model pick, since "on
    // this model" would otherwise cost a pinned model that wasn't at fault.
    const unsent = "400 prompt_cache_retention is not supported on this model";
    const failure = (await collect(createOpenCodeAgent(fakeRunner(...refusal(unsent)).runner), request)).find((event) => event.kind === "error") as
        { code?: string; message: string } | undefined;
    expect(failure?.code).toBe("provider-outage");
    expect(failure?.message).toContain(unsent);
});

// OpenCode compacts an overflowing session itself; what reaches the turn is an overflow it could not clear, which the
// daemon re-runs in a fresh session instead of resuming this one into the same wall.
test("a session past the model's window is coded context-overflow, by OpenCode's own name or the provider's words", async () => {
    const failed = (error: unknown): unknown[] => [
        { type: "session.error", properties: { sessionID: "s1", error } },
        { type: "session.idle", properties: { sessionID: "s1" } },
    ];
    const named = { name: "ContextOverflowError", data: { message: "Input exceeds the model's limit" } };
    expect(await collect(createOpenCodeAgent(fakeRunner(failed(named)).runner), request)).toEqual([
        { kind: "error", code: "context-overflow", message: "Input exceeds the model's limit" },
        { kind: "done" },
    ]);
    // xAI's own sentence, reaching OpenCode as a plain API error when its compaction is switched off.
    const xai = "This model's maximum prompt length is 131072 but the request contains 145312 tokens.";
    expect(await collect(createOpenCodeAgent(fakeRunner(failed({ name: "APIError", data: { message: xai } })).runner), request)).toEqual([
        { kind: "error", code: "context-overflow", message: xai },
        { kind: "done" },
    ]);
});

// The translator lists models from its built-in catalog, so it can list one Google does not offer these accounts; Google
// then answers 404 NOT_FOUND. Coded model-unavailable so the picker hides that model, and the sentence names it.
test("Google's NOT_FOUND on a Google turn is coded model-unavailable and names the refused model", async () => {
    const notFound = (): OpenCodeRunner =>
        fakeRunner([
            { type: "session.created", properties: { info: { id: "s1" } } },
            {
                type: "session.error",
                properties: { sessionID: "s1", error: { name: "APIError", data: { message: "Requested entity was not found." } } },
            },
        ]).runner;
    const turn = (model: string) => ({ ...request, spec: { ...request.spec, model } });

    const events = await collect(createOpenCodeAgent(notFound(), OPENCODE_GEMINI_PROVIDER), turn("claude-opus-5-5-high"));
    const failure = events.find((event) => event.kind === "error") as { code?: string; message: string } | undefined;
    expect(failure?.code).toBe("model-unavailable");
    expect(failure?.message).toContain("claude-opus-5-5-high");
    expect(failure?.message).toContain("Requested entity was not found.");

    // The same sentence from a thrown prompt (outside the event stream) is read the same way.
    const throwing: OpenCodeRunner = async function* () {
        yield { type: "session.created", properties: { info: { id: "s2" } } } as Event;
        throw new Error("Requested entity was not found.");
    };
    const thrown = (await collect(createOpenCodeAgent(throwing, OPENCODE_GEMINI_PROVIDER), turn("claude-opus-5-5-high"))).find(
        (event) => event.kind === "error",
    ) as { code?: string } | undefined;
    expect(thrown?.code).toBe("model-unavailable");

    // Grok never says this sentence for a model, so its turns keep the error as it came.
    expect(await collect(createOpenCodeAgent(notFound()), turn("grok-4"))).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "error", message: "Requested entity was not found." },
        { kind: "done" },
    ]);
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
    expect(await collect(createOpenCodeAgent(runner), request)).toEqual([
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
    client: Awaited<ReturnType<OpenCodeService["client"]>>;
    leases: { selections: Parameters<OpenCodeService["acquire"]>[0][]; active: number; released: number };
    streamReturned: () => boolean;
    aborted: () => boolean;
    recorded: string[][];
    prompts: (string | undefined)[];
    systems: (string | undefined)[];
    shown: (Record<string, boolean> | undefined)[];
    deleted: string[];
    scopes: { subscribed: string[]; watched: string[] };
    order: string[];
    mounted: { directory: string; servers: readonly OpenCodeMcpServer[] }[];
    judges: Map<string, SessionJudge>;
} => {
    let aborted = false;
    let returned = false;
    const selections: Parameters<OpenCodeService["acquire"]>[0][] = [];
    const leases = { selections, active: 0, released: 0 };
    const prompts: (string | undefined)[] = [];
    const systems: (string | undefined)[] = [];
    const shown: (Record<string, boolean> | undefined)[] = [];
    const deleted: string[] = [];
    const recorded: string[][] = [];
    // Mimics the real stream's opening `server.connected`, which the runner awaits before creating a session.
    const withHello: Event[] = [{ type: "server.connected", properties: {} } as unknown as Event, ...events];
    let streamSignal: AbortSignal | undefined;
    const stream = {
        // Like the pinned SDK, return() cannot wake a prefetched next() on this native generator; only abort can.
        async *[Symbol.asyncIterator]() {
            if (order[0] === undefined) {
                order.push("read");
            }
            try {
                yield* withHello;
                if (!closes) {
                    await new Promise<void>((resolve) => {
                        if (streamSignal?.aborted === true) {
                            resolve();
                        } else {
                            streamSignal?.addEventListener("abort", () => resolve(), { once: true });
                        }
                    });
                }
            } finally {
                returned = true;
            }
        },
    };
    // SAFETY: the runner uses only this SDK client's session methods; the fake returns every response field it reads.
    const client = {
        event: { subscribe: async () => ({ stream }) },
        session: {
            create: async () => {
                order.push("create");
                return { data: { id: "s1" } };
            },
            promptAsync: async (options: { body?: { model?: { modelID?: string }; system?: string; tools?: Record<string, boolean> } }) => {
                const modelID = options.body?.model?.modelID;
                prompts.push(modelID);
                systems.push(options.body?.system);
                shown.push(options.body?.tools);
                if (rejectModel !== undefined && modelID === rejectModel.id) {
                    throw new Error(rejectModel.message);
                }
                return {};
            },
            abort: async () => {
                aborted = true;
                return {};
            },
            delete: async (options: { path: { id: string } }) => {
                deleted.push(options.path.id);
                return {};
            },
        },
    } as unknown as Awaited<ReturnType<OpenCodeService["client"]>>;
    const scopes = { subscribed: [] as string[], watched: [] as string[] };
    const order: string[] = [];
    const mounted: { directory: string; servers: readonly OpenCodeMcpServer[] }[] = [];
    const judges = new Map<string, SessionJudge>();
    const openCode = unstubbed<OpenCodeService>("openCode", {
        client: async () => client,
        acquire: async (model) => {
            leases.selections.push(model);
            leases.active += 1;
            return {
                client,
                release: () => {
                    leases.released += 1;
                    leases.active -= 1;
                },
            };
        },
        events: async (directory, signal) => {
            scopes.subscribed.push(directory);
            streamSignal = signal;
            return { stream };
        },
        watch: async (directory) => void scopes.watched.push(directory),
        recordModels: async (ids) => void recorded.push(ids),
        mount: async (directory, servers) => {
            order.push("mount");
            mounted.push({ directory, servers });
            return async () => void order.push("unmount");
        },
        judges: {
            register: (session, judge) => void judges.set(session, judge),
            release: (session) => void judges.delete(session),
        },
    });
    return {
        openCode,
        client,
        leases,
        streamReturned: () => returned,
        aborted: () => aborted,
        recorded,
        prompts,
        systems,
        shown,
        deleted,
        scopes,
        order,
        mounted,
        judges,
    };
};

const runnerTurn: OpenCodeTurn = { prompt: "hi", cwd: WORKSPACE_ROOT, agent: "build", signal: new AbortController().signal };

// A helper's request (agent-request.ts `policy.sealed`): every tool hidden, OpenCode's own included, its system prompt
// in OpenCode's `system` field, and its session deleted once it answered, since nothing resumes it.
test("a sealed request asks with every tool hidden and leaves no session behind", async () => {
    const fake = fakeOpenCode([sessionCreated("s1"), sessionIdle("s1")]);
    for await (const event of createOpenCodeRunner(fake.openCode)({ ...runnerTurn, system: "Answer exactly.", sealed: true })) {
        void event;
    }
    expect(fake.shown).toEqual([{ "*": false }]);
    expect(fake.systems).toEqual(["Answer exactly."]);
    expect(fake.deleted).toEqual(["s1"]);
    expect(fake.leases.released).toBe(1);
});

test("a turn keeps its session, to be resumed", async () => {
    const fake = fakeOpenCode([sessionCreated("s1"), sessionIdle("s1")]);
    for await (const event of createOpenCodeRunner(fake.openCode)(runnerTurn)) {
        void event;
    }
    expect(fake.deleted).toEqual([]);
});

test("an ungated Google turn leases its exact requested model and releases it on completion", async () => {
    const { openCode, leases, prompts } = fakeOpenCode([sessionCreated("s1"), sessionIdle("s1")]);
    for await (const event of createOpenCodeRunner(openCode)({ ...runnerTurn, provider: "intentic-gemini", model: "claude-opus-5-5-high" })) {
        expect(leases.active).toBe(1);
        void event;
    }
    expect(leases.selections).toEqual([{ providerID: "intentic-gemini", modelID: "claude-opus-5-5-high" }]);
    expect(prompts).toEqual(["claude-opus-5-5-high"]);
    expect(leases.active).toBe(0);
    expect(leases.released).toBe(1);
});

test.each(["events", "watch", "session"])("a setup failure before a judge exists releases the runtime: %s", async (stage) => {
    const fake = fakeOpenCode([]);
    const fail = async (): Promise<never> => {
        throw new Error("setup failed");
    };
    const openCode = {
        ...fake.openCode,
        events: stage === "events" ? fail : fake.openCode.events,
        watch: stage === "watch" ? fail : fake.openCode.watch,
    };
    if (stage === "session") {
        fake.client.session.create = fail;
    }
    const turn = createOpenCodeRunner(openCode)(runnerTurn)[Symbol.asyncIterator]();
    await expect(turn.next()).rejects.toThrow("setup failed");
    expect(fake.leases.active).toBe(0);
    expect(fake.leases.released).toBe(1);
    expect(fake.judges.size).toBe(0);
    if (stage === "session") {
        expect(fake.streamReturned()).toBe(true);
    }
});

test("closing the consumer cancels a silent native SSE read before releasing the runtime", async () => {
    const fake = fakeOpenCode([sessionCreated("s1")]);
    const turn = createOpenCodeRunner(fake.openCode)(runnerTurn)[Symbol.asyncIterator]();
    expect(await turn.next()).toEqual({ done: false, value: sessionCreated("s1") });
    expect(fake.leases.active).toBe(1);
    expect(fake.streamReturned()).toBe(false);
    expect(await turn.return?.()).toEqual({ done: true, value: undefined });
    expect(fake.streamReturned()).toBe(true);
    expect(fake.order).toEqual(["read", "create", "mount", "unmount"]);
    expect(fake.leases.active).toBe(0);
    expect(fake.leases.released).toBe(1);
});

test("a resumed session also acquires a runtime lease without creating a replacement session", async () => {
    const fake = fakeOpenCode([sessionIdle("s1")]);
    for await (const event of createOpenCodeRunner(fake.openCode)({ ...runnerTurn, sessionId: "s1", model: "grok-4" })) {
        void event;
    }
    expect(fake.order).toEqual(["read", "mount", "unmount"]);
    expect(fake.leases.selections).toEqual([{ providerID: "xai", modelID: "grok-4" }]);
    expect(fake.leases.released).toBe(1);
});

test("the runtime stays leased until MCP cleanup completes", async () => {
    const fake = fakeOpenCode([sessionIdle("s1")]);
    const entered = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const openCode = {
        ...fake.openCode,
        mount: async () => async () => {
            entered.resolve();
            await cleanup.promise;
        },
    };
    const drain = async (): Promise<void> => {
        for await (const event of createOpenCodeRunner(openCode)(runnerTurn)) {
            void event;
        }
    };
    const finished = drain();
    await entered.promise;
    expect(fake.leases.active).toBe(1);
    expect(fake.leases.released).toBe(0);
    cleanup.resolve();
    await finished;
    expect(fake.leases.active).toBe(0);
    expect(fake.leases.released).toBe(1);
});

test("a cleanup failure still releases the runtime lease", async () => {
    const fake = fakeOpenCode([sessionIdle("s1")]);
    const openCode = {
        ...fake.openCode,
        mount: async () => async () => {
            throw new Error("cleanup failed");
        },
    };
    const drain = async (): Promise<void> => {
        for await (const event of createOpenCodeRunner(openCode)(runnerTurn)) {
            void event;
        }
    };
    await expect(drain()).rejects.toThrow("cleanup failed");
    expect(fake.leases.active).toBe(0);
    expect(fake.leases.released).toBe(1);
});

// An unscoped subscription still connects and heartbeats but carries no session events, so this is asserted on the
// call, not on the emitted frames.
test("createOpenCodeRunner subscribes and watches scoped to the turn's own directory", async () => {
    const { openCode, scopes } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event,
    ]);
    const worktree = `${HISTORY_ROOT}/worktrees/wise-condor/repo`;
    for await (const event of createOpenCodeRunner(openCode)({ ...runnerTurn, cwd: worktree })) {
        void event;
    }
    expect(scopes.subscribed).toEqual([worktree]);
    // Boot only knows the workspace root; an isolated turn's worktree is watched because the turn itself registers it.
    expect(scopes.watched).toEqual([worktree]);
});

// `subscribe()` returns a lazy generator; the HTTP request isn't made until the first read, so reading must happen
// before the session is created.
test("createOpenCodeRunner opens the stream before the session it must not miss the creation of", async () => {
    const { openCode, order } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event,
    ]);
    const seen: string[] = [];
    for await (const event of createOpenCodeRunner(openCode)(runnerTurn)) {
        seen.push(event.type);
    }
    // The servers are mounted once the session exists and let go as the turn ends.
    expect(order).toEqual(["read", "create", "mount", "unmount"]);
    expect(seen).toEqual(["session.created", "session.idle"]);
});

// The runtime is shared: `intentic-gemini` is the same adapter serving Google, so a failure message must name the
// backend actually picked.
test("a stalled turn is reported against the backend the user actually picked", async () => {
    const stalled = (provider: string | undefined): Promise<void> =>
        (async () => {
            for await (const event of createOpenCodeRunner(fakeOpenCode([]).openCode, { ...DEFAULT_TURN_TIMEOUTS, inactivityMs: 20 })({
                ...runnerTurn,
                ...opt("provider", provider),
            })) {
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
    for await (const event of createOpenCodeRunner(openCode)(runnerTurn)) {
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
    const events = await collect(createOpenCodeAgent(createOpenCodeRunner(openCode), "intentic-gemini"), request);
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
    for await (const event of createOpenCodeRunner(openCode)({ ...runnerTurn, signal: controller.signal })) {
        seen.push(event.type);
    }
    expect(seen).toEqual(["session.created"]);
});

test("createOpenCodeRunner ends the turn on session.error even while the stream stays open", async () => {
    const { openCode } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        { type: "session.error", properties: { sessionID: "s1", error: { name: "X", data: { message: "boom" } } } } as unknown as Event,
    ]);
    const seen: string[] = [];
    for await (const event of createOpenCodeRunner(openCode)(runnerTurn)) {
        seen.push(event.type);
    }
    expect(seen).toEqual(["session.created", "session.error"]);
});

test("createOpenCodeRunner aborts and throws when no event arrives within the inactivity window", async () => {
    const { openCode, aborted, leases } = fakeOpenCode([{ type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event]);
    const drain = async (): Promise<void> => {
        for await (const event of createOpenCodeRunner(openCode, { ...DEFAULT_TURN_TIMEOUTS, inactivityMs: 20 })(runnerTurn)) {
            void event;
        }
    };
    await expect(drain()).rejects.toThrow(/timed out/);
    expect(aborted()).toBe(true);
    expect(leases.active).toBe(0);
    expect(leases.released).toBe(1);
});

// A Stop before the session exists reaches an already-aborted signal, which a fresh listener never fires on; asserted
// on the call since the turn ends the same way either way.
test("a turn stopped before its session existed still tells OpenCode to abort it", async () => {
    const { openCode, aborted, leases } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event,
    ]);
    const controller = new AbortController();
    controller.abort();

    for await (const event of createOpenCodeRunner(openCode)({ ...runnerTurn, signal: controller.signal })) {
        void event;
    }

    expect(aborted()).toBe(true);
    expect(leases.active).toBe(0);
    expect(leases.released).toBe(1);
});

test("a retry's announced next attempt pushes the inactivity deadline past it", async () => {
    const { openCode, aborted, leases } = fakeOpenCode([
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
            for await (const event of createOpenCodeRunner(openCode, { ...DEFAULT_TURN_TIMEOUTS, inactivityMs: 20 })(runnerTurn)) {
                seen.push(event.type);
            }
        })(),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(aborted()).toBe(true);
    expect(leases.active).toBe(0);
    expect(leases.released).toBe(1);
    expect(seen).toEqual(["session.created", "session.status"]);
});

test("createOpenCodeRunner self-heals a model-not-found rejection: records the named models and re-prompts once", async () => {
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
    for await (const event of createOpenCodeRunner(openCode)({ ...runnerTurn, model: "grok-4-stale" })) {
        seen.push(event.type);
    }
    expect(seen).toEqual(["session.created", "message.part.updated", "session.idle"]);
    expect(recorded).toEqual([["grok-4-latest"]]);
    expect(prompts).toEqual(["grok-4-stale", "grok-4-latest"]);
});

test("createOpenCodeRunner's self-heal ignores a stale idle from the failed prompt, waiting for the corrected turn", async () => {
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
    for await (const event of createOpenCodeRunner(openCode)({ ...runnerTurn, model: "grok-4-stale" })) {
        seen.push(event.type);
    }
    expect(seen).toEqual(["session.created", "message.part.updated", "session.idle"]);
});

test("createOpenCodeRunner surfaces a model error it cannot self-heal (no named alternatives), recording nothing", async () => {
    const { openCode, recorded, prompts } = fakeOpenCode([
        { type: "session.created", properties: { info: { id: "s1" } } } as unknown as Event,
        { type: "session.error", properties: { sessionID: "s1", error: { data: { message: "Model not found: xai/grok-x." } } } } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event,
    ]);
    const seen: string[] = [];
    for await (const event of createOpenCodeRunner(openCode)({ ...runnerTurn, model: "grok-x" })) {
        seen.push(event.type);
    }
    expect(seen).toEqual(["session.created", "session.error"]);
    expect(recorded).toEqual([]);
    expect(prompts).toEqual(["grok-x"]);
});

test("createOpenCodeRunner self-heals a model-not-found REJECTION from the initial prompt (thrown, not a session.error event)", async () => {
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
    for await (const event of createOpenCodeRunner(openCode)({ ...runnerTurn, model: "grok-4" })) {
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
    const events = await collect(createOpenCodeAgent(createOpenCodeRunner(openCode)), { ...request, spec: { ...request.spec, model: "grok-x" } });
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

    await collect(createOpenCodeAgent(createOpenCodeRunner(openCode)), {
        ...request,
        spec: { ...request.spec, systemAppend: "House rules: be brief." },
    });

    expect(systems).toEqual(["House rules: be brief."]);
});

// An empty system message is not the same request as no message; OpenCode's own prompt should stand.
test("nothing to say sends no system field", async () => {
    const { openCode, systems } = fakeOpenCode([{ type: "session.idle", properties: { sessionID: "s1" } } as unknown as Event]);

    await collect(createOpenCodeAgent(createOpenCodeRunner(openCode)), request);

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

    await collect(
        createOpenCodeAgent(runner),
        {
            ...request,
            spec: { ...request.spec, systemAppend: "House rules: be brief." },
            policy: { ...request.policy, permissionMode: "plan" as const },
        },
        () => ({
            approve: true,
        }),
    );

    expect(calls.map((call) => call.system)).toEqual(["House rules: be brief.", "House rules: be brief."]);
});

// Grok and Gemini reach the same remote MCP servers Codex does: the runner mounts them in the turn's directory, and the
// prompt shows the session its own conversation's servers and hides every other conversation's.
test("createOpenCodeRunner mounts the turn's servers where it runs, shows its session only those, and lets them go", async () => {
    const { openCode, mounted, shown, order } = fakeOpenCode([sessionCreated("s1"), sessionIdle("s1")]);
    const mounts = openCodeMounts("chat-1", [{ name: "web", url: "http://127.0.0.1:7000/mcp/web", token: "turn-bearer" }]);

    for await (const event of createOpenCodeRunner(openCode)({ ...runnerTurn, mounts })) {
        void event;
    }

    expect(mounted).toEqual([{ directory: WORKSPACE_ROOT, servers: mcpServersOf(mounts) }]);
    expect(shown).toEqual([{ "intentic_*": false, [`${mounts.prefix}*`]: true }]);
    expect(order).toEqual(["read", "create", "mount", "unmount"]);
});

test("a turn with no servers of its own is still shown no other conversation's", async () => {
    const { openCode, shown } = fakeOpenCode([sessionCreated("s1"), sessionIdle("s1")]);

    for await (const event of createOpenCodeRunner(openCode)(runnerTurn)) {
        void event;
    }

    expect(shown).toEqual([{ "intentic_*": false }]);
});

// A prompt OpenCode refuses outright ends the turn before its loop starts; the servers and the judges go with it.
test("a turn whose prompt is refused still lets go of its servers and its sessions' judges", async () => {
    const { openCode, order, judges } = fakeOpenCode([sessionCreated("s1")], { id: "gemini-gone", message: "upstream unavailable" });
    const gate = unstubbed<CommandGuard>("gate", { enforcing: true });

    const drain = async (): Promise<void> => {
        for await (const event of createOpenCodeRunner(openCode)({ ...runnerTurn, provider: "intentic-gemini", model: "gemini-gone", gate })) {
            void event;
        }
    };

    await expect(drain()).rejects.toThrow("upstream unavailable");
    expect(order).toEqual(["read", "create", "mount", "unmount"]);
    expect([...judges.keys()]).toEqual([]);
});

// The detached permission watcher answers asks, but the card it raises is this turn's: it goes out on the turn's own
// stream, and while it waits on a person the turn's silence limit is held, then runs again from the answer.
test("a card the turn's judge raises goes out in order, and the turn waits on it past the silence window", async () => {
    const { openCode, judges } = fakeOpenCode([sessionCreated("s1")]);
    const gate = unstubbed<CommandGuard>("gate", { enforcing: true });
    const card: AgentEvent = {
        kind: "permission",
        requestId: "card-1",
        toolName: "Bash",
        title: "This command would push to main",
        displayName: "Run command",
    };
    const answer: AgentEvent = { kind: "resolved", requestId: "card-1" };
    const turn = createOpenCodeRunner(openCode, { ...DEFAULT_TURN_TIMEOUTS, inactivityMs: 50 })({ ...runnerTurn, gate })[Symbol.asyncIterator]();

    expect((await turn.next()).value).toMatchObject({ type: "session.created" });
    const judge = judges.get("s1");
    if (judge === undefined) {
        throw new Error("the turn registered no judge for its own session");
    }
    // As answerPermission does: the clock held for the whole consult, the card raised, then its resolution.
    const release = judge.hold();
    judge.push(card);
    expect(await turn.next()).toEqual({ done: false, value: { type: "intentic.frame", frame: card } });

    const waiting = turn.next();
    // Six silence windows on a card, and the turn is still waiting rather than timed out.
    await new Promise((resolve) => setTimeout(resolve, 300));
    judge.push(answer);
    release();
    expect(await waiting).toEqual({ done: false, value: { type: "intentic.frame", frame: answer } });

    // Answered, the turn is back on the clock: silence from here is a stall again.
    await expect(turn.next()).rejects.toThrow(/timed out/);
});

test("a card raised mid-turn reaches the chat in order with the session's own frames", async () => {
    const card: AgentEvent = {
        kind: "permission",
        requestId: "card-2",
        toolName: "Bash",
        title: "This command would push to main",
        displayName: "Run command",
    };
    const { runner } = fakeRunner([
        sessionCreated("s1"),
        { type: "intentic.frame", frame: card },
        { type: "intentic.frame", frame: { kind: "resolved", requestId: "card-2" } },
        { type: "message.part.updated", properties: { part: { type: "text", id: "tx1", sessionID: "s1", messageID: "m1", text: "Pushed." } } },
        sessionIdle("s1"),
    ]);

    const events = await collect(createOpenCodeAgent(runner), request);

    expect(events).toEqual([
        { kind: "session", sessionId: "s1" },
        card,
        { kind: "resolved", requestId: "card-2" },
        { kind: "delta", text: "Pushed." },
        { kind: "done" },
    ]);
});

// The turn hands its runner the same remote list Codex takes, under its conversation's names, and a call to one of them
// reads as the MCP call it is rather than as the key OpenCode spells it with.
test("an OpenCode turn mounts the turn's remote servers, and a call to one reads as that server's tool", async () => {
    const web = { name: "web", url: "http://127.0.0.1:7000/mcp/web", token: "turn-bearer" };
    const mounts = openCodeMounts("chat-1", [web]);
    const { runner, calls } = fakeRunner([
        sessionCreated("s1"),
        {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    id: "tp1",
                    sessionID: "s1",
                    messageID: "m1",
                    callID: "c1",
                    tool: `${mounts.prefix}web_browser_navigate`,
                    state: { status: "running", input: { url: "https://example.com" }, time: { start: 0 } },
                },
            },
        },
        sessionIdle("s1"),
    ]);

    const events = await collect(createOpenCodeAgent(runner), {
        ...request,
        spec: { ...request.spec, conversationId: "chat-1" },
        tools: { remote: [web] },
    });

    expect(calls.map((call) => call.mounts)).toEqual([mounts]);
    expect(events.find((event) => event.kind === "tool_call")).toMatchObject({ id: "c1", name: "Browser navigate" });
});

// OpenCode can move on from an ask nobody answered (a refused sibling ask stops the session), so the turn's end settles
// any card it left, rather than leaving it up with nobody waiting on the answer.
test("a card still open when the turn ends is settled with it", async () => {
    let consulted: Promise<GuardOutcome> | undefined;
    const runner: OpenCodeRunner = async function* (turn) {
        if (turn.gate === undefined) {
            throw new Error("the adapter hands every turn its gate");
        }
        consulted = consultWith(turn.gate, "git push --force origin main", vendorSubject("Bash"), () => {});
        yield sessionCreated("s1");
        yield sessionIdle("s1");
    };

    await collect(createOpenCodeAgent(runner), {
        ...request,
        policy: { judging: "on", rulebook: "approval" },
        hooks: { cards, judge: async () => ({ decision: "ask", sentence: "Rewrites the shared history." }) },
    });

    expect(await consulted).toEqual({ allow: false, reason: "The turn ended before you answered." });
});
