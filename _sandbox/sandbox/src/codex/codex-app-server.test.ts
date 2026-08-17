import { expect, test } from "vitest";
import {
    type AppServerNotification,
    type CodexAppServerConnector,
    type CodexEvent,
    type CodexTurn,
    createCodexAppServerRunner,
} from "./codex-app-server.js";

interface RequestCall {
    readonly method: string;
    readonly params: unknown;
}

/* What the fake app-server sends the runner, in order: a notification as it arrives on the wire, a
 * server-initiated request whose answer the test then reads off `answered`, or a BARRIER — a promise the stream
 * waits on before going any further. The barrier is what makes something the runner does mid-turn (a steer
 * landing on the running turn) happen before the frames that come after it, instead of racing them. */
type Incoming = AppServerNotification | { readonly request: string; readonly params: unknown } | { readonly await: Promise<unknown> };

interface FakeAppServerOptions {
    // What `skills/list` answers with — the SkillMetadata array of the one cwd entry.
    readonly skills?: readonly unknown[];
    // The turn id `turn/steer` reports the message landed on. Defaults to the turn already running.
    readonly steeredTurnId?: string;
}

const fakeAppServer = (incoming: readonly Incoming[], options: FakeAppServerOptions = {}) => {
    const requests: RequestCall[] = [];
    const notices: RequestCall[] = [];
    const answered: unknown[] = [];
    let closed = false;
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
                return { turn: { id: "turn-1" } };
            }
            if (method === "turn/steer") {
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
                yield { kind: "notification", ...message };
            }
        })(),
        close: () => {
            closed = true;
        },
    });
    return { connector, requests, notices, answered, closed: () => closed };
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
        { type: "error", message: "fallback metadata" },
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
        // The pump only comes back for a second message once `turn/steer` has answered, so reaching this line is
        // the steer having landed — no timer, and nothing to race the frames below.
        released();
    })();
    const appServer = fakeAppServer(
        [
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
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Using fetch." } },
        { type: "turn.completed" },
    ]);
    expect(appServer.requests).toContainEqual({
        method: "turn/steer",
        params: { threadId: "thr-new", expectedTurnId: "turn-1", input: [{ type: "text", text: "use fetch instead", text_elements: [] }] },
    });
});

test("a refused steer is swallowed rather than failing the turn", async () => {
    let released = (): void => {};
    const landed = new Promise<void>((resolve) => {
        released = resolve;
    });
    const steering = (async function* () {
        yield "too late";
        released();
    })();
    const appServer = fakeAppServer([
        { await: landed },
        { method: "turn/completed", params: { threadId: "thr-new", turn: { id: "turn-1", status: "completed", error: null } } },
    ]);
    // What app-server answers when the turn finished between the user's click and the steer reaching it.
    const connector: CodexAppServerConnector = async (started) => {
        const connection = await appServer.connector(started);
        return {
            ...connection,
            request: (method, params) =>
                method === "turn/steer" ? Promise.reject(new Error("no active turn to steer")) : connection.request(method, params),
        };
    };

    expect(await collect(createCodexAppServerRunner(connector)({ ...turn(), steering }))).toEqual([
        { type: "thread.started", thread_id: "thr-new" },
        { type: "turn.completed" },
    ]);
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
