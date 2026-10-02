import { SteeringQueue } from "../../agent/checkpoints/agent-steering.js";
import { createCodexAgent } from "./codex-agent.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { fakeCodexProcess, memoryFleet } from "../../testing.js";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { WORKSPACE_ROOT } from "@intentic/constants";
import {
    type AppServerNotification,
    type CodexAppServerConnector,
    type CodexEvent,
    type CodexTurn,
    createCodexAppServerRunner,
    stdioConnector,
} from "./codex-app-server.js";

interface RequestCall {
    readonly method: string;
    readonly params: unknown;
}

// What the fake app-server sends, in order: a notification, a server request answered via answered, or a barrier
// promise the stream waits on before continuing (so a mid-turn steer lands before the frames after it).
type Incoming = AppServerNotification | { readonly request: string; readonly params: unknown } | { readonly await: Promise<unknown> };

interface FakeAppServerOptions {
    // What skills/list answers with: the SkillMetadata array of the one cwd entry.
    readonly skills?: readonly unknown[];
    readonly refuseBeforeStarted?: boolean;
    readonly refuseSteers?: boolean;
    // The turn id turn/steer reports the message landed on. Defaults to the turn already running.
    readonly steeredTurnId?: string;
}

const fakeAppServer = (incoming: readonly Incoming[], options: FakeAppServerOptions = {}) => {
    const requests: RequestCall[] = [];
    const notices: RequestCall[] = [];
    const answered: unknown[] = [];
    let closed = false;
    let active = false;
    let starts = 0;
    const accepted: unknown[] = [];
    const connector: CodexAppServerConnector = async () => ({
        request: async (method, params) => {
            requests.push({ method, params });
            if (method === "initialize") {
                return { userAgent: "fake" };
            }
            if (method === "thread/start") {
                return { thread: { id: "thr-new" } };
            }
            if (method === "thread/resume") {
                return { thread: { id: "thr-resumed" } };
            }
            if (method === "skills/list") {
                return { data: [{ cwd: "/workspace/repo", errors: [], skills: options.skills ?? [] }] };
            }
            if (method === "turn/start") {
                starts += 1;
                return { turn: { id: `turn-${starts}` } };
            }
            if (method === "turn/steer") {
                if (options.refuseSteers || (options.refuseBeforeStarted && !active)) {
                    throw new Error("no active turn to steer");
                }
                accepted.push(params);
                return { turnId: options.steeredTurnId ?? "turn-1" };
            }
            throw new Error(`unstubbed app-server request ${method}`);
        },
        notify: (method, params) => notices.push({ method, params }),
        messages: (async function* () {
            for (const message of incoming) {
                if ("await" in message) {
                    await message.await;
                    continue;
                }
                if ("request" in message) {
                    yield { kind: "request", method: message.request, params: message.params, respond: (result) => answered.push(result) };
                    continue;
                }
                if (message.method === "turn/started") {
                    active = true;
                }
                yield { kind: "notification", ...message };
            }
        })(),
        close: () => {
            closed = true;
        },
    });
    return { connector, requests, notices, answered, accepted, closed: () => closed };
};

const TRANSLATOR_CONFIG: NonNullable<CodexTurn["config"]> = {
    "model_providers.translator": {
        name: "translator",
        base_url: "http://127.0.0.1:8788/v1",
        wire_api: "responses",
        env_key: "CODEX_API_KEY",
        http_headers: { "x-openai-actor-authorization": "intentic" },
        supports_websockets: false,
    },
};

const turn = (sessionId?: string): CodexTurn => ({
    prompt: "draw a crocodile",
    images: ["/workspace/reference.png"],
    ...(sessionId !== undefined ? { sessionId } : {}),
    env: { CODEX_HOME: "/codex" },
    modelProvider: "translator",
    config: TRANSLATOR_CONFIG,
    options: {
        workingDirectory: "/workspace/repo",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        model: "gpt-5.6-sol",
        modelReasoningEffort: "low",
    },
    signal: new AbortController().signal,
});

const collect = async (events: AsyncIterable<CodexEvent>): Promise<CodexEvent[]> => {
    const collected: CodexEvent[] = [];
    for await (const event of events) {
        collected.push(event);
    }
    return collected;
};

// Codex's own subagents run in threads of their own on the turn's connection; the spawn call names the thread only as it
// completes, and the thread may already have begun. Everything it sends reads as the spawn call's subagent, and its
// commands answer to the same rules its parent's do rather than being waved through.
test("a subagent's thread reads under the spawn call that started it, and its commands are asked about", async () => {
    const spawn = (status: string, receiverThreadIds: readonly string[], agentsStates: object) => ({
        id: "spawn-1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status,
        senderThreadId: "thr-new",
        receiverThreadIds,
        prompt: "Port the purge job\nRetire rows past 30 days.",
        model: "gpt-5.6-luna",
        reasoningEffort: null,
        agentsStates,
    });
    const { connector, answered } = fakeAppServer([
        { method: "item/started", params: { threadId: "thr-new", turnId: "turn-1", item: spawn("inProgress", [], {}) } },
        {
            method: "item/started",
            params: {
                threadId: "thr-child",
                turnId: "turn-c1",
                item: { id: "cmd-c1", type: "commandExecution", command: "rg purge", status: "inProgress", aggregatedOutput: "" },
            },
        },
        {
            method: "item/completed",
            params: {
                threadId: "thr-new",
                turnId: "turn-1",
                item: spawn("completed", ["thr-child"], { "thr-child": { status: "pendingInit", message: null } }),
            },
        },
        {
            request: "item/commandExecution/requestApproval",
            params: { threadId: "thr-child", turnId: "turn-c1", command: "rm -rf dist", cwd: `${WORKSPACE_ROOT}/app` },
        },
        {
            method: "item/completed",
            params: { threadId: "thr-child", turnId: "turn-c1", item: { id: "msg-c1", type: "agentMessage", text: "Ported." } },
        },
        {
            method: "thread/tokenUsage/updated",
            params: {
                threadId: "thr-child",
                turnId: "turn-c1",
                tokenUsage: { total: { inputTokens: 500, outputTokens: 50 }, last: { inputTokens: 500, outputTokens: 50 } },
            },
        },
        { method: "turn/completed", params: { threadId: "thr-child", turn: { id: "turn-c1", status: "completed" } } },
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed" } } },
    ]);
    const events = await collect(createCodexAppServerRunner(connector)(turn()));
    const read = events.flatMap((event) => {
        if (event.type === "item.started" || event.type === "item.completed") {
            return [`${event.type} ${event.item.type} ${event.item.id} under ${event.parent ?? "the turn"}`];
        }
        if (event.type === "command_approval.requested") {
            // Where Codex will run it rides along, so the gate places an install by it.
            return [`asked about ${event.command} in ${event.cwd ?? "the turn's cwd"}`];
        }
        if (event.type === "subagent.usage") {
            return [`${event.parent} spent ${event.input}+${event.output}`];
        }
        return event.type === "subagent.ended" ? [`${event.parent} ended ${event.status}`] : [];
    });
    expect(read).toEqual([
        "item.started collab_agent_tool_call spawn-1 under the turn",
        "item.completed collab_agent_tool_call spawn-1 under the turn",
        "item.started command_execution cmd-c1 under spawn-1",
        "asked about rm -rf dist in /work/app",
        "item.completed agent_message msg-c1 under spawn-1",
        "spawn-1 spent 500+50",
        "spawn-1 ended completed",
    ]);
    // Asked, not waved through: nothing answered the subagent's command before the card did.
    expect(answered).toEqual([]);
    expect(events.find((event) => event.type === "item.completed" && event.item.type === "collab_agent_tool_call")).toMatchObject({
        item: {
            tool: "spawnAgent",
            status: "completed",
            prompt: "Port the purge job\nRetire rows past 30 days.",
            model: "gpt-5.6-luna",
            receivers: ["thr-child"],
            states: { "thr-child": { status: "pendingInit" } },
        },
    });
});

test("starts an app-server thread and turn with native text/image inputs and translator configuration", async () => {
    const appServer = fakeAppServer([
        { method: "turn/started", params: { threadId: "thr-new", turn: { id: "turn-1" } } },
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed", error: null } } },
    ]);

    expect(await collect(createCodexAppServerRunner(appServer.connector)(turn()))).toEqual([
        { type: "thread.started", thread_id: "thr-new" },
        { type: "turn.started" },
        { type: "turn.completed" },
    ]);
    expect(appServer.requests).toEqual([
        {
            method: "initialize",
            params: {
                clientInfo: { name: "intentic", title: "Intentic", version: "1" },
                capabilities: { experimentalApi: true, requestAttestation: false },
            },
        },
        {
            method: "thread/start",
            params: {
                model: "gpt-5.6-sol",
                modelProvider: "translator",
                cwd: "/workspace/repo",
                approvalPolicy: "never",
                sandbox: "danger-full-access",
                config: TRANSLATOR_CONFIG,
            },
        },
        { method: "skills/list", params: { cwds: ["/workspace/repo"], forceReload: false } },
        {
            method: "turn/start",
            params: {
                threadId: "thr-new",
                input: [
                    { type: "text", text: "draw a crocodile", text_elements: [] },
                    { type: "localImage", path: "/workspace/reference.png" },
                ],
                cwd: "/workspace/repo",
                approvalPolicy: "never",
                sandboxPolicy: { type: "dangerFullAccess" },
                model: "gpt-5.6-sol",
                effort: "low",
            },
        },
    ]);
    expect(appServer.notices).toEqual([{ method: "initialized", params: {} }]);
    expect(appServer.closed()).toBe(true);
});

test("resumes an existing thread without emitting a duplicate session event", async () => {
    const appServer = fakeAppServer([
        { method: "turn/completed", params: { threadId: "thr-resumed", turn: { id: "turn-1", status: "completed", error: null } } },
    ]);

    expect(await collect(createCodexAppServerRunner(appServer.connector)(turn("thr-old")))).toEqual([{ type: "turn.completed" }]);
    expect(appServer.requests[1]).toMatchObject({ method: "thread/resume", params: { threadId: "thr-old" } });
});

test("normalizes image generation and latest-turn token usage", async () => {
    const appServer = fakeAppServer([
        {
            method: "item/started",
            params: {
                threadId: "thr-new",
                turnId: "turn-1",
                item: { type: "imageGeneration", id: "ig-1", status: "in_progress", revisedPrompt: null, result: "" },
            },
        },
        {
            method: "item/completed",
            params: {
                threadId: "thr-new",
                turnId: "turn-1",
                item: {
                    type: "imageGeneration",
                    id: "ig-1",
                    status: "completed",
                    revisedPrompt: "a green crocodile",
                    result: "cG5n",
                    savedPath: "/codex/generated_images/thr-new/ig-1.png",
                },
            },
        },
        {
            method: "thread/tokenUsage/updated",
            params: {
                threadId: "thr-new",
                turnId: "turn-1",
                tokenUsage: {
                    last: {
                        totalTokens: 17,
                        inputTokens: 10,
                        cachedInputTokens: 3,
                        cacheWriteInputTokens: 1,
                        outputTokens: 7,
                        reasoningOutputTokens: 2,
                    },
                },
            },
        },
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed", error: null } } },
    ]);

    expect(await collect(createCodexAppServerRunner(appServer.connector)(turn()))).toEqual([
        { type: "thread.started", thread_id: "thr-new" },
        { type: "item.started", item: { id: "ig-1", type: "image_generation", status: "in_progress", result: "" } },
        {
            type: "item.completed",
            item: {
                id: "ig-1",
                type: "image_generation",
                status: "completed",
                revised_prompt: "a green crocodile",
                result: "cG5n",
                saved_path: "/codex/generated_images/thr-new/ig-1.png",
            },
        },
        {
            type: "turn.completed",
            usage: {
                input_tokens: 10,
                cached_input_tokens: 3,
                cache_write_input_tokens: 1,
                output_tokens: 7,
                reasoning_output_tokens: 2,
            },
        },
    ]);
});

test("normalizes app-server's structured file-change kind", async () => {
    const appServer = fakeAppServer([
        {
            method: "item/completed",
            params: {
                threadId: "thr-new",
                turnId: "turn-1",
                item: {
                    type: "fileChange",
                    id: "patch-1",
                    changes: [{ path: "/workspace/src/app.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@" }],
                    status: "completed",
                },
            },
        },
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed", error: null } } },
    ]);

    expect(await collect(createCodexAppServerRunner(appServer.connector)(turn()))).toContainEqual({
        type: "item.completed",
        item: { id: "patch-1", type: "file_change", changes: [{ path: "/workspace/src/app.ts", kind: "update" }], status: "completed" },
    });
});

test("normalizes app-server reasoning, command, MCP, search, plan, compaction, and warning shapes", async () => {
    const appServer = fakeAppServer([
        {
            method: "item/completed",
            params: { threadId: "thr-new", turnId: "turn-1", item: { type: "reasoning", id: "r1", summary: ["first", "second"] } },
        },
        {
            method: "item/completed",
            params: {
                threadId: "thr-new",
                turnId: "turn-1",
                item: { type: "commandExecution", id: "c1", command: "pnpm test", aggregatedOutput: "passed", exitCode: 0, status: "completed" },
            },
        },
        {
            method: "item/completed",
            params: {
                threadId: "thr-new",
                turnId: "turn-1",
                item: {
                    type: "mcpToolCall",
                    id: "mcp-1",
                    server: "docs",
                    tool: "search",
                    status: "completed",
                    result: { content: [{ type: "text", text: "result" }] },
                    error: null,
                },
            },
        },
        {
            method: "item/completed",
            params: { threadId: "thr-new", turnId: "turn-1", item: { type: "webSearch", id: "w1", query: "crocodile" } },
        },
        {
            method: "turn/plan/updated",
            params: { threadId: "thr-new", turnId: "turn-1", explanation: null, plan: [{ step: "draw", status: "completed" }] },
        },
        {
            method: "item/completed",
            params: { threadId: "thr-new", turnId: "turn-1", item: { type: "contextCompaction", id: "compact-1" } },
        },
        { method: "warning", params: { threadId: "thr-new", message: "fallback metadata" } },
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed", error: null } } },
    ]);

    expect(await collect(createCodexAppServerRunner(appServer.connector)(turn()))).toEqual([
        { type: "thread.started", thread_id: "thr-new" },
        { type: "item.completed", item: { id: "r1", type: "reasoning", text: "first\nsecond" } },
        {
            type: "item.completed",
            item: {
                id: "c1",
                type: "command_execution",
                command: "pnpm test",
                aggregated_output: "passed",
                exit_code: 0,
                status: "completed",
            },
        },
        {
            type: "item.completed",
            item: {
                id: "mcp-1",
                type: "mcp_tool_call",
                server: "docs",
                tool: "search",
                status: "completed",
                result: { content: [{ type: "text", text: "result" }] },
            },
        },
        { type: "item.completed", item: { id: "w1", type: "web_search", query: "crocodile" } },
        { type: "item.updated", item: { id: "plan-turn-1", type: "todo_list", items: [{ text: "draw", completed: true }] } },
        { type: "item.completed", item: { id: "compact-1", type: "context_compaction" } },
        // Its own frame, not `error`: the turn carries on after a warning, so the agent must be free to mute or drop it.
        { type: "warning", message: "fallback metadata" },
        { type: "turn.completed" },
    ]);
});

test("maps failed and interrupted app-server turns to terminal failures", async () => {
    const failed = fakeAppServer([
        {
            method: "turn/completed",
            params: { threadId: "thr-new", turn: { id: "turn-1", status: "failed", error: { message: "usage limit reached" } } },
        },
    ]);
    expect(await collect(createCodexAppServerRunner(failed.connector)(turn()))).toContainEqual({
        type: "turn.failed",
        error: { message: "usage limit reached" },
    });

    const interrupted = fakeAppServer([
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "interrupted", error: null } } },
    ]);
    expect(await collect(createCodexAppServerRunner(interrupted.connector)(turn()))).toContainEqual({
        type: "turn.failed",
        error: { message: "Codex turn was interrupted" },
    });
});

const SKILLS = [
    {
        name: "release",
        description: "The whole release runbook, written for a model to read in full.",
        shortDescription: "legacy blurb",
        interface: { shortDescription: "Cut a release" },
        path: "/workspace/repo/.codex/skills/release",
        enabled: true,
        scope: "repo",
    },
    { name: "retired", description: "switched off in config", path: "/workspace/repo/.codex/skills/retired", enabled: false, scope: "user" },
];

test("publishes the thread's enabled skills and sends a picked command as a structured skill input", async () => {
    const appServer = fakeAppServer(
        [{ method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed", error: null } } }],
        { skills: SKILLS },
    );

    const events = await collect(createCodexAppServerRunner(appServer.connector)({ ...turn(), prompt: "/release patch please" }));

    // The one-line blurb wins over the body, and the disabled skill is not offered at all.
    expect(events).toContainEqual({
        type: "commands",
        skills: [{ name: "release", description: "Cut a release", path: "/workspace/repo/.codex/skills/release" }],
    });
    expect(appServer.requests.find((call) => call.method === "turn/start")?.params).toMatchObject({
        input: [
            { type: "skill", name: "release", path: "/workspace/repo/.codex/skills/release" },
            { type: "text", text: "patch please", text_elements: [] },
            { type: "localImage", path: "/workspace/reference.png" },
        ],
    });
});

test("prose that merely starts with a slash is sent verbatim", async () => {
    const appServer = fakeAppServer(
        [{ method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed", error: null } } }],
        { skills: SKILLS },
    );

    await collect(createCodexAppServerRunner(appServer.connector)({ ...turn(), prompt: "/etc/hosts is stale — fix it" }));

    expect(appServer.requests.find((call) => call.method === "turn/start")?.params).toMatchObject({
        input: [
            { type: "text", text: "/etc/hosts is stale — fix it", text_elements: [] },
            { type: "localImage", path: "/workspace/reference.png" },
        ],
    });
});

test("a skills/list that fails costs the popover and nothing else", async () => {
    const appServer = fakeAppServer([
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed", error: null } } },
    ]);
    // The fake answers with an empty list; a build that refuses the method outright takes the same path.
    expect(await collect(createCodexAppServerRunner(appServer.connector)(turn()))).toEqual([
        { type: "thread.started", thread_id: "thr-new" },
        { type: "turn.completed" },
    ]);
});

test("a steering message reaches the running turn, and the run follows the turn it landed on", async () => {
    let released = (): void => {};
    const landed = new Promise<void>((resolve) => {
        released = resolve;
    });
    const steering = (async function* () {
        yield "use fetch instead";
        // Only resumes for a second message after turn/steer answers, so reaching here means the steer has landed.
        released();
    })();
    const appServer = fakeAppServer(
        [
            { method: "turn/started", params: { threadId: "thr-new", turn: { id: "turn-1" } } },
            { await: landed },
            // The turn the steer replaced completes as interrupted; that must NOT end this run.
            { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "interrupted", error: null } } },
            {
                method: "item/completed",
                params: { threadId: "thr-new", turnId: "turn-2", item: { type: "agentMessage", id: "m1", text: "Using fetch." } },
            },
            { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-2", status: "completed", error: null } } },
        ],
        { steeredTurnId: "turn-2" },
    );

    expect(await collect(createCodexAppServerRunner(appServer.connector)({ ...turn(), steering }))).toEqual([
        { type: "thread.started", thread_id: "thr-new" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Using fetch." } },
        { type: "turn.completed" },
    ]);
    expect(appServer.requests).toContainEqual({
        method: "turn/steer",
        params: { threadId: "thr-new", expectedTurnId: "turn-1", input: [{ type: "text", text: "use fetch instead", text_elements: [] }] },
    });
});

test("steering waits for turn/started before reaching an app-server that refuses early input", async () => {
    const appServer = fakeAppServer(
        [
            { await: new Promise<void>((resolve) => setTimeout(resolve, 0)) },
            { method: "turn/started", params: { threadId: "thr-new", turn: { id: "turn-1" } } },
            { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed" } } },
        ],
        { refuseBeforeStarted: true },
    );
    const steering = (async function* () {
        yield "use fetch instead";
    })();
    await collect(createCodexAppServerRunner(appServer.connector)({ ...turn(), steering }));
    expect(appServer.accepted).toEqual([
        {
            threadId: "thr-new",
            expectedTurnId: "turn-1",
            input: [{ type: "text", text: "use fetch instead", text_elements: [] }],
        },
    ]);
});

test("a refused steer becomes the next turn's input on the same thread", async () => {
    const appServer = fakeAppServer(
        [
            { method: "turn/started", params: { threadId: "thr-new", turn: { id: "turn-1" } } },
            { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed" } } },
            { method: "turn/started", params: { threadId: "thr-new", turn: { id: "turn-2" } } },
            { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-2", status: "completed" } } },
        ],
        { refuseSteers: true },
    );
    const steering = (async function* () {
        yield "too late";
    })();
    await collect(createCodexAppServerRunner(appServer.connector)({ ...turn(), steering }));
    expect(appServer.requests.filter((call) => call.method === "turn/start").map((call) => call.params)).toEqual([
        expect.objectContaining({
            threadId: "thr-new",
            input: [
                { type: "text", text: "draw a crocodile", text_elements: [] },
                { type: "localImage", path: "/workspace/reference.png" },
            ],
        }),
        expect.objectContaining({ threadId: "thr-new", input: [{ type: "text", text: "too late", text_elements: [] }] }),
    ]);
});

test("aborting an active stdio turn sends turn/interrupt before killing the app-server", async () => {
    jest.useFakeTimers();
    const process = fakeCodexProcess();
    const controller = new AbortController();
    const connection = await stdioConnector(
        async () => "codex",
        () => process.child,
    )({ ...turn(), signal: controller.signal });
    try {
        await connection.request("turn/start", { threadId: "thr-new" });
        process.notify("turn/started", { threadId: "thr-new", turn: { id: "turn-1" } });
        await connection.messages[Symbol.asyncIterator]().next();
        controller.abort();
        expect(process.requests).toContainEqual({ method: "turn/interrupt", params: { threadId: "thr-new", turnId: "turn-1" } });
        expect(process.kills()).toBe(0);
        await advanceTimersByTimeAsync(3000);
        expect(process.kills()).toBe(1);
    } finally {
        connection.close();
        jest.useRealTimers();
    }
});

test("a question request is handed over with its options, and the picks travel back on the same request", async () => {
    const appServer = fakeAppServer([
        {
            request: "item/tool/requestUserInput",
            params: {
                threadId: "thr-new",
                turnId: "turn-1",
                itemId: "ask-1",
                isBlocking: true,
                questions: [
                    {
                        id: "q1",
                        header: "Auth",
                        question: "Which sign-in should the route accept?",
                        options: [
                            { label: "Google", description: "SSO through the connected account" },
                            { label: "Email", description: "A code sent to the address" },
                        ],
                        isOther: false,
                        isSecret: false,
                    },
                    { id: "q2", header: "Key", question: "Paste the API key", options: null, isOther: true, isSecret: true },
                ],
            },
        },
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed", error: null } } },
    ]);

    const events = await collect(createCodexAppServerRunner(appServer.connector)(turn()));
    const asked = events.filter((event): event is Extract<CodexEvent, { type: "user_input.requested" }> => event.type === "user_input.requested");

    expect(asked).toHaveLength(1);
    expect(asked[0]!.questions).toEqual([
        {
            id: "q1",
            header: "Auth",
            question: "Which sign-in should the route accept?",
            options: [
                { label: "Google", description: "SSO through the connected account" },
                { label: "Email", description: "A code sent to the address" },
            ],
            secret: false,
        },
        // An open question arrives with no options, and the secret flag travels so the card seam can refuse it.
        { id: "q2", header: "Key", question: "Paste the API key", options: [], secret: true },
    ]);

    asked[0]!.respond({ q1: ["Google"], q2: ["refused"] });
    expect(appServer.answered).toEqual([{ answers: { q1: { answers: ["Google"] }, q2: { answers: ["refused"] } } }]);
});

test("a question raised on another turn is answered empty instead of reaching a person", async () => {
    const appServer = fakeAppServer([
        {
            request: "item/tool/requestUserInput",
            params: { threadId: "thr-new", turnId: "turn-other", itemId: "ask-1", isBlocking: true, questions: [] },
        },
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed", error: null } } },
    ]);

    expect(await collect(createCodexAppServerRunner(appServer.connector)(turn()))).toEqual([
        { type: "thread.started", thread_id: "thr-new" },
        { type: "turn.completed" },
    ]);
    expect(appServer.answered).toEqual([{ answers: {} }]);
});

// Codex asks before every MCP tool that isn't annotated read-only, which is most of the browser's. Answering anything
// but accept (a method-not-found included) reaches the model as "user rejected MCP tool call".
test("grants an MCP tool call's approval and takes the session-wide yes when it is offered", async () => {
    const appServer = fakeAppServer([
        {
            request: "mcpServer/elicitation/request",
            params: {
                threadId: "thr-new",
                turnId: "turn-1",
                serverName: "browser",
                mode: "form",
                _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_title: "Navigate to a URL" },
                message: 'Allow the browser MCP server to run tool "browser_navigate"?',
                requestedSchema: { type: "object", properties: {} },
            },
        },
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed", error: null } } },
    ]);

    expect(await collect(createCodexAppServerRunner(appServer.connector)(turn()))).toEqual([
        { type: "thread.started", thread_id: "thr-new" },
        { type: "turn.completed" },
    ]);
    expect(appServer.answered).toEqual([{ action: "accept", content: null, _meta: { persist: "session" } }]);
});

// `always` alone would amend the owner's config from inside a turn, so the reply carries no persistence at all.
test("grants an MCP tool call's approval once when no session-wide yes is offered", async () => {
    const appServer = fakeAppServer([
        {
            request: "mcpServer/elicitation/request",
            params: {
                threadId: "thr-new",
                turnId: "turn-1",
                serverName: "browser",
                mode: "form",
                _meta: { codex_approval_kind: "mcp_tool_call", persist: "always" },
                message: 'Allow the browser MCP server to run tool "browser_click"?',
                requestedSchema: { type: "object", properties: {} },
            },
        },
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed", error: null } } },
    ]);

    await collect(createCodexAppServerRunner(appServer.connector)(turn()));
    expect(appServer.answered).toEqual([{ action: "accept", content: null, _meta: null }]);
});

test("declines an elicitation that is a server's own question, since nothing here can render one", async () => {
    const appServer = fakeAppServer([
        {
            request: "mcpServer/elicitation/request",
            params: {
                threadId: "thr-new",
                turnId: null,
                serverName: "github",
                mode: "url",
                _meta: null,
                message: "Finish signing in",
                url: "https://github.com/login/device",
                elicitationId: "github-auth-123",
            },
        },
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed", error: null } } },
    ]);

    await collect(createCodexAppServerRunner(appServer.connector)(turn()));
    expect(appServer.answered).toEqual([{ action: "decline", content: null, _meta: null }]);
});

test("rejects malformed fields on a known app-server item", async () => {
    const appServer = fakeAppServer([
        {
            method: "item/completed",
            params: { threadId: "thr-new", turnId: "turn-1", item: { type: "agentMessage", id: "m1", text: 42 } },
        },
    ]);

    await expect(collect(createCodexAppServerRunner(appServer.connector)(turn()))).rejects.toThrow("invalid agentMessage.text");
    expect(appServer.closed()).toBe(true);
});

test("final completion refuses a steer while terminal usage is still being consumed", async () => {
    const steering = new SteeringQueue();
    const appServer = fakeAppServer([
        { method: "turn/started", params: { threadId: "thr-new", turn: { id: "turn-1" } } },
        {
            method: "thread/tokenUsage/updated",
            params: {
                threadId: "thr-new",
                turnId: "turn-1",
                tokenUsage: {
                    last: {
                        inputTokens: 10,
                        cachedInputTokens: 3,
                        cacheWriteInputTokens: 1,
                        outputTokens: 5,
                        reasoningOutputTokens: 0,
                    },
                },
            },
        },
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed" } } },
    ]);
    const agent = createCodexAgent({ codexHome: "/codex", runner: createCodexAppServerRunner(appServer.connector) });
    const admitted: boolean[] = [];
    for await (const event of agent({
        spec: { prompt: "hello", cwd: WORKSPACE_ROOT, steering },
        policy: {},
        tools: {},
        credential: { kind: "container" },
        hooks: { cards: parkedCards(memoryFleet().conversations) },
        signal: new AbortController().signal,
    })) {
        if (event.kind === "usage") {
            admitted.push(steering.push("too late"));
        }
    }
    steering.close();
    expect(admitted).toEqual([false]);
    expect(steering.delivered).toBe(0);
});

test("stdio interruption settles without killing, and a subagent cannot become its target", async () => {
    jest.useFakeTimers();
    const process = fakeCodexProcess();
    const controller = new AbortController();
    const connection = await stdioConnector(
        async () => "codex",
        () => process.child,
    )({ ...turn(), signal: controller.signal });
    const messages = connection.messages[Symbol.asyncIterator]();
    try {
        await connection.request("turn/start", { threadId: "thr-new" });
        process.notify("turn/started", { threadId: "thr-new", turn: { id: "turn-1" } });
        await messages.next();
        process.notify("turn/started", { threadId: "thr-child", turn: { id: "child-turn" } });
        await messages.next();
        controller.abort();
        expect(process.requests.filter((call) => call.method === "turn/interrupt")).toEqual([
            { method: "turn/interrupt", params: { threadId: "thr-new", turnId: "turn-1" } },
        ]);
        process.notify("turn/completed", { threadId: "thr-new", turn: { id: "turn-1", status: "interrupted" } });
        await messages.next();
        await advanceTimersByTimeAsync(3000);
        expect(process.kills()).toBe(0);
    } finally {
        connection.close();
        jest.useRealTimers();
    }
});

test("subagent usage separates cached and cache-written input from uncached input", async () => {
    const appServer = fakeAppServer([
        {
            method: "item/completed",
            params: {
                threadId: "thr-new",
                turnId: "turn-1",
                item: {
                    id: "spawn-1",
                    type: "collabAgentToolCall",
                    tool: "spawnAgent",
                    status: "completed",
                    senderThreadId: "thr-new",
                    receiverThreadIds: ["thr-child"],
                    agentsStates: {},
                },
            },
        },
        {
            method: "thread/tokenUsage/updated",
            params: {
                threadId: "thr-child",
                turnId: "child-turn",
                tokenUsage: {
                    total: { inputTokens: 500, cachedInputTokens: 300, cacheWriteInputTokens: 100, outputTokens: 50 },
                },
            },
        },
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed" } } },
    ]);
    const events = await collect(createCodexAppServerRunner(appServer.connector)(turn()));
    expect(events.filter((event) => event.type === "subagent.usage")).toEqual([
        { type: "subagent.usage", parent: "spawn-1", input: 100, output: 50, cacheRead: 300, cacheCreation: 100 },
    ]);
});
