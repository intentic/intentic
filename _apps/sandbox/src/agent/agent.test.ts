import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { type QueryFn, runAgent } from "./agent.js";

// Build a fake QueryFn yielding canned SDK messages (cast to SDKMessage — tests exercise only the fields
// runAgent reads), so the agent loop is verified without the SDK, a binary, or network.
const fakeQuery = (...messages: unknown[]): QueryFn =>
    async function* () {
        for (const message of messages) {
            yield message as SDKMessage;
        }
    };

const collect = async (request: Parameters<typeof runAgent>[0], queryFn: QueryFn): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of runAgent(request, queryFn)) {
        events.push(event);
    }
    return events;
};

const request = { prompt: "add a /ping route", cwd: "/work", signal: new AbortController().signal };

test("a turn surfaces session, text deltas, tool actions, and a terminal done", async () => {
    const events = await collect(
        request,
        fakeQuery(
            { type: "system", subtype: "init", session_id: "sess-1", model: "sonnet" },
            { type: "stream_event", session_id: "sess-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Adding " } } },
            {
                type: "assistant",
                session_id: "sess-1",
                message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "src/app.ts", old_string: "a", new_string: "b" } }] },
            },
            {
                type: "assistant",
                session_id: "sess-1",
                message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "pnpm test" } }] },
            },
            { type: "result", subtype: "success", result: "done" },
        ),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "sess-1" },
        { kind: "init", model: "sonnet" },
        { kind: "delta", text: "Adding " },
        {
            kind: "tool_call",
            id: "e1",
            name: "Edit",
            category: "edit",
            status: "in_progress",
            target: "src/app.ts",
            locations: [{ path: "src/app.ts" }],
            content: [{ type: "diff", path: "src/app.ts", oldText: "a", newText: "b" }],
        },
        { kind: "tool_call", id: "b1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
        { kind: "done" },
    ]);
});

test("the SDK env always marks the sandbox and carries the per-turn oauth token only when given", async () => {
    let captured: Options | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.options;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    // IS_SANDBOX is always set so the CLI accepts --dangerously-skip-permissions under root.
    await collect({ ...request, oauthToken: "tok-xyz" }, capture);
    expect(captured?.env?.["IS_SANDBOX"]).toBe("1");
    expect(captured?.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("tok-xyz");

    captured = undefined;
    await collect(request, capture);
    expect(captured?.env?.["IS_SANDBOX"]).toBe("1");
    expect(captured?.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
});

test("a custom endpoint points the SDK at ANTHROPIC_BASE_URL and withholds the subscription OAuth token", async () => {
    let captured: Options | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.options;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    // A routed turn (codex/grok under the Claude Code harness) carries baseUrl + authToken. The Anthropic
    // subscription token must NEVER leave for a foreign endpoint — even if an oauthToken is also present, baseUrl
    // wins and CLAUDE_CODE_OAUTH_TOKEN is dropped.
    await collect({ ...request, baseUrl: "http://127.0.0.1:8788", authToken: "router-key", oauthToken: "tok-xyz", model: "gpt-5-codex" }, capture);
    expect(captured?.env?.["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:8788");
    expect(captured?.env?.["ANTHROPIC_AUTH_TOKEN"]).toBe("router-key");
    expect(captured?.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    expect(captured?.model).toBe("gpt-5-codex");
});

test("systemAppend rides into the preset system prompt only when given", async () => {
    let captured: Options | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.options;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect({ ...request, systemAppend: "## Delegating\nUse codex exec." }, capture);
    expect(captured?.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "## Delegating\nUse codex exec." });

    captured = undefined;
    await collect(request, capture);
    expect(captured?.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
});

test("the autonomous turn registers the request's tools as remote http MCP servers", async () => {
    let captured: Options | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.options;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect({ ...request, tools: [{ name: "obs", url: "https://signoz.example.com/mcp", token: "tok" }] }, capture);
    expect(captured?.mcpServers).toEqual({
        obs: { type: "http", url: "https://signoz.example.com/mcp", alwaysLoad: true, headers: { Authorization: "Bearer tok" } },
    });

    captured = undefined;
    await collect(request, capture);
    expect(captured?.mcpServers).toBeUndefined();
});

test("the plan turn keeps the ui server and merges the request's tools alongside it", async () => {
    let captured: Options | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.options;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect({ ...request, plan: true, tools: [{ name: "obs", url: "https://signoz.example.com/mcp", token: "tok" }] }, capture);
    // The plan flow's AskUserQuestion server stays; the agent's remote tools are added next to it.
    expect(captured?.mcpServers?.["ui"]).toBeDefined();
    expect(captured?.mcpServers?.["obs"]).toEqual({
        type: "http",
        url: "https://signoz.example.com/mcp",
        alwaysLoad: true,
        headers: { Authorization: "Bearer tok" },
    });
});

test("plugin checkout dirs are passed to the SDK as local plugins", async () => {
    let captured: Options | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.options;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect({ ...request, plugins: ["/work/.intentic/plugins/x"] }, capture);
    expect(captured?.plugins).toEqual([{ type: "local", path: "/work/.intentic/plugins/x" }]);

    captured = undefined;
    await collect(request, capture);
    expect(captured?.plugins).toBeUndefined();
});

test("a non-success result becomes an error followed by done", async () => {
    const events = await collect(request, fakeQuery({ type: "result", subtype: "error_max_turns", session_id: "s" }));
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", message: "agent did not complete (error_max_turns)" },
        { kind: "done" },
    ]);
});

test("a rate_limit assistant error is tagged with a code and a human message, not a bare crash line", async () => {
    const events = await collect(request, fakeQuery({ type: "assistant", session_id: "s", error: "rate_limit", message: { content: [] } }));
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        {
            kind: "error",
            code: "rate_limit",
            message:
                "Claude usage limit reached — this is the Claude subscription's rate limit resetting, not a workspace problem. Your last message wasn't processed; try again shortly.",
        },
        { kind: "done" },
    ]);
});

test("a non-rate-limit assistant error stays a plain agent error", async () => {
    const events = await collect(request, fakeQuery({ type: "assistant", session_id: "s", error: "overloaded", message: { content: [] } }));
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", message: "agent error: overloaded" }, { kind: "done" }]);
});

test("a rate_limit_event surfaces the subscription usage snapshot (window, utilization, reset)", async () => {
    const events = await collect(
        request,
        fakeQuery({
            type: "rate_limit_event",
            session_id: "s",
            rate_limit_info: { status: "allowed_warning", resetsAt: 1_800_000_000, rateLimitType: "five_hour", utilization: 73 },
        }),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "rate_limit_info", status: "allowed_warning", resetsAt: 1_800_000_000, rateLimitType: "five_hour", utilization: 73 },
        { kind: "done" },
    ]);
});

test("a rate_limit_event with only a status omits the optional usage fields", async () => {
    const events = await collect(request, fakeQuery({ type: "rate_limit_event", session_id: "s", rate_limit_info: { status: "allowed" } }));
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "rate_limit_info", status: "allowed" }, { kind: "done" }]);
});

test("a message_start and result surface context-window fill (input + both cache buckets) over the model's window", async () => {
    const events = await collect(
        request,
        fakeQuery(
            {
                type: "stream_event",
                session_id: "s",
                event: {
                    type: "message_start",
                    message: {
                        model: "claude-opus-4-8",
                        usage: { input_tokens: 40_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2000 },
                    },
                },
            },
            { type: "result", subtype: "success", modelUsage: { "claude-opus-4-8": { contextWindow: 200_000 } } },
        ),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "context_usage", tokens: 142_000, contextWindow: 200_000 },
        { kind: "done" },
    ]);
});

test("the result usage frame carries token counts and prompt-cache buckets", async () => {
    const events = await collect(
        request,
        fakeQuery({
            type: "result",
            subtype: "success",
            total_cost_usd: 0.42,
            usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 3000 },
            modelUsage: {},
        }),
    );
    expect(events).toEqual([
        { kind: "usage", costUsd: 0.42, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 90_000, cacheCreationTokens: 3000 },
        { kind: "done" },
    ]);
});

test("no context_usage is emitted when the result carries no context window", async () => {
    const events = await collect(
        request,
        fakeQuery(
            { type: "stream_event", session_id: "s", event: { type: "message_start", message: { model: "m", usage: { input_tokens: 1000 } } } },
            { type: "result", subtype: "success", modelUsage: {} },
        ),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "done" }]);
});

const throwing: QueryFn = async function* () {
    yield { type: "system", session_id: "s" } as SDKMessage;
    throw new Error("stream blew up");
};

test("a thrown error from the SDK is reported as an error event, then done", async () => {
    expect(await collect(request, throwing)).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", message: "stream blew up" },
        { kind: "done" },
    ]);
});
