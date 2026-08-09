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

const fakeAppServer = (notifications: readonly AppServerNotification[]) => {
    const requests: RequestCall[] = [];
    const notices: RequestCall[] = [];
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
            if (method === "turn/start") {
                return { turn: { id: "turn-1" } };
            }
            throw new Error(`unstubbed app-server request ${method}`);
        },
        notify: (method, params) => notices.push({ method, params }),
        notifications: (async function* () {
            yield* notifications;
        })(),
        close: () => {
            closed = true;
        },
    });
    return { connector, requests, notices, closed: () => closed };
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
