import type { Options, PermissionResult, PermissionUpdate, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentReply } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { type AgentQuery, type QueryFn, runAgent } from "./agent.js";
import { resolveRequest } from "./agent-requests.js";
import { SteeringQueue } from "./agent-steering.js";

// Build a fake QueryFn yielding canned SDK messages (cast to SDKMessage — tests exercise only the fields
// runAgent reads), so the agent loop is verified without the SDK, a binary, or network.
const fakeQuery = (...messages: unknown[]): QueryFn =>
    async function* () {
        for (const message of messages) {
            yield message as SDKMessage;
        }
    };

// The same fake, plus the control-request methods a real Query answers — a canned generator has none, which is
// why they're optional on AgentQuery in the first place.
const fakeQueryWith = (extras: Partial<AgentQuery>, ...messages: unknown[]): QueryFn =>
    () =>
        Object.assign(
            (async function* () {
                for (const message of messages) {
                    yield message as SDKMessage;
                }
            })(),
            extras,
        );

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
                message: {
                    content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "src/app.ts", old_string: "a", new_string: "b" } }],
                },
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

test("each prose block closes with text_end, before the tool calls that block introduced", async () => {
    const events = await collect(
        request,
        fakeQuery(
            { type: "stream_event", session_id: "s1", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
            {
                type: "stream_event",
                session_id: "s1",
                event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading the router." } },
            },
            { type: "stream_event", session_id: "s1", event: { type: "content_block_stop", index: 0 } },
            // The tool_use block's own start/stop must not close a prose bubble — only a text block's does.
            { type: "stream_event", session_id: "s1", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use" } } },
            { type: "stream_event", session_id: "s1", event: { type: "content_block_stop", index: 1 } },
            { type: "assistant", session_id: "s1", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }] } },
            { type: "stream_event", session_id: "s1", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
            {
                type: "stream_event",
                session_id: "s1",
                event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Found it." } },
            },
            { type: "stream_event", session_id: "s1", event: { type: "content_block_stop", index: 0 } },
            { type: "result", subtype: "success", result: "done" },
        ),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "delta", text: "Reading the router." },
        { kind: "text_end" },
        { kind: "tool_call", id: "b1", name: "Bash", category: "execute", status: "in_progress", target: "ls" },
        { kind: "delta", text: "Found it." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

test("a subagent's prose block closes its own bubble, not the parent turn's", async () => {
    // Both streams number their blocks from 0, so a shared index would let the subagent's stop retire the
    // parent's still-open block. The boundary is keyed per agent precisely to make this ordering hold.
    const events = await collect(
        request,
        fakeQuery(
            { type: "stream_event", session_id: "s1", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
            {
                type: "stream_event",
                session_id: "s1",
                event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Delegating." } },
            },
            {
                type: "stream_event",
                session_id: "s1",
                parent_tool_use_id: "t1",
                event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
            },
            {
                type: "stream_event",
                session_id: "s1",
                parent_tool_use_id: "t1",
                event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sub prose" } },
            },
            { type: "stream_event", session_id: "s1", parent_tool_use_id: "t1", event: { type: "content_block_stop", index: 0 } },
            { type: "stream_event", session_id: "s1", event: { type: "content_block_stop", index: 0 } },
            { type: "result", subtype: "success", result: "done" },
        ),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s1" },
        { kind: "delta", text: "Delegating." },
        { kind: "delta", text: "sub prose", parentToolUseId: "t1" },
        { kind: "text_end", parentToolUseId: "t1" },
        { kind: "text_end" },
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

test("the interactive guidance always rides the preset system prompt, with systemAppend after it", async () => {
    let captured: Options | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.options;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    // The model has to be TOLD the widgets exist, in every mode — otherwise it writes "A) … B) …" as prose.
    await collect(request, capture);
    const base = captured?.systemPrompt as { type: string; preset: string; append: string };
    expect(base).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(base.append).toContain("AskUserQuestion");
    expect(base.append).toContain("EnterPlanMode");

    captured = undefined;
    await collect({ ...request, systemAppend: "## Delegating\nUse codex exec." }, capture);
    const withAppend = captured?.systemPrompt as { append: string };
    expect(withAppend.append).toBe(`${base.append}\n\n## Delegating\nUse codex exec.`);
});

test("every turn wires the ui ask server, the AskUserQuestion alias, and the permission gate", async () => {
    let captured: Options | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.options;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    // The autonomous posture is the one the composer defaults away from plan mode into — it used to get no
    // question tool at all, which is why the model fell back to prose options.
    await collect(request, capture);
    expect(captured?.mcpServers?.["ui"]).toBeDefined();
    expect(captured?.toolAliases).toEqual({ AskUserQuestion: "mcp__ui__ask" });
    expect(captured?.canUseTool).toBeTypeOf("function");
    expect(captured?.permissionMode).toBe("bypassPermissions");
    expect(captured?.allowDangerouslySkipPermissions).toBe(true);
});

test("the request's tools become remote http MCP servers alongside the ui server, in every mode", async () => {
    let captured: Options | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.options;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };
    const obs = { type: "http", url: "https://signoz.example.com/mcp", alwaysLoad: true, headers: { Authorization: "Bearer tok" } };
    const tools = [{ name: "obs", url: "https://signoz.example.com/mcp", token: "tok" }];

    await collect({ ...request, tools }, capture);
    expect(captured?.mcpServers?.["obs"]).toEqual(obs);
    expect(captured?.mcpServers?.["ui"]).toBeDefined();

    captured = undefined;
    await collect({ ...request, permissionMode: "plan" as const, tools }, capture);
    expect(captured?.mcpServers?.["obs"]).toEqual(obs);
    expect(captured?.mcpServers?.["ui"]).toBeDefined();
    expect(captured?.permissionMode).toBe("plan");
    // bypassPermissions is the only mode that skips the SDK's permission machinery — plan must not.
    expect(captured?.allowDangerouslySkipPermissions).toBe(false);
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

// Drive the permission gate end-to-end: the fake query calls `canUseTool` mid-stream, the test answers the card
// the way the browser does (POST /agent/reply → resolveRequest), and the gate's decision comes back to assert on.
const decide = async (
    turn: Parameters<typeof runAgent>[0],
    call: { tool: string; input?: Record<string, unknown>; suggestions?: PermissionUpdate[] },
    answer: (event: AgentEvent) => AgentReply,
): Promise<{ result: PermissionResult; card: AgentEvent }> => {
    let result: PermissionResult | undefined;
    let card: AgentEvent | undefined;
    const query: QueryFn = async function* (args) {
        const gate = args.options.canUseTool!;
        result = await gate(call.tool, call.input ?? {}, { signal: turn.signal, suggestions: call.suggestions } as never);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };
    for await (const event of runAgent(turn, query)) {
        if (event.kind === "permission" || event.kind === "plan") {
            card = event;
            resolveRequest(answer(event));
        }
    }
    return { result: result!, card: card! };
};

test("'always' grants the whole tool for the session, alongside whatever the SDK suggested", async () => {
    const suggestion: PermissionUpdate = {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "pnpm install:*" }],
        behavior: "allow",
        destination: "localSettings",
    };
    const { result, card } = await decide(
        { ...request, permissionMode: "acceptEdits" },
        { tool: "Bash", input: { command: "pnpm install" }, suggestions: [suggestion] },
        (event) => ({ kind: "permission", requestId: event.requestId, decision: "always" }),
    );

    expect(card).toMatchObject({ kind: "permission", toolName: "Bash", alwaysLabel: "Don't ask again for Bash" });
    // The SDK's own suggestion is command-scoped — the next command would ask again — so the tool-wide rule the
    // button's wording promises rides with it.
    expect(result).toMatchObject({
        behavior: "allow",
        decisionClassification: "user_permanent",
        updatedPermissions: [suggestion, { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }],
    });
});

test("a card with no SDK suggestions still offers 'always', and 'once' persists nothing", async () => {
    const { result, card } = await decide({ ...request, permissionMode: "default" }, { tool: "WebFetch" }, (event) => ({
        kind: "permission",
        requestId: event.requestId,
        decision: "once",
    }));

    expect(card).toMatchObject({ alwaysLabel: "Don't ask again for WebFetch" });
    expect(result).toEqual({ behavior: "allow", updatedInput: {}, decisionClassification: "user_temporary" });
});

test("an approved plan returns to the posture the turn started in when the reply names none", async () => {
    const approve = (event: AgentEvent): AgentReply => ({ kind: "plan", requestId: event.requestId, approve: true });

    // The agent put ITSELF into plan mode (EnterPlanMode) on a turn the user started in Auto — approving must
    // hand those permissions back, not demote the rest of the session to per-command prompts.
    const auto = await decide({ ...request, permissionMode: "bypassPermissions" }, { tool: "ExitPlanMode", input: { plan: "# Plan" } }, approve);
    expect(auto.result).toMatchObject({ updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] });

    // A turn that started in plan mode has nothing to restore; auto-accepting edits is the floor.
    const planned = await decide({ ...request, permissionMode: "plan" }, { tool: "ExitPlanMode", input: { plan: "# Plan" } }, approve);
    expect(planned.result).toMatchObject({ updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
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

const usageResponse = (rateLimits: unknown) => () => Promise.resolve({ rate_limits: rateLimits } as never);

test("a settled turn re-reads EVERY plan-limit pool, not just whichever one was binding", async () => {
    const events = await collect(
        request,
        fakeQueryWith(
            {
                usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usageResponse({
                    five_hour: { utilization: 12.4, resets_at: "2026-07-27T18:00:00.000Z" },
                    seven_day: { utilization: 98, resets_at: "2026-07-29T09:00:00.000Z" },
                    // A pool the plan has but the provider has no reading for — dropped, not shown at 0%.
                    seven_day_opus: { utilization: null, resets_at: null },
                    model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "2026-07-29T09:00:00.000Z" }],
                }),
            },
            { type: "result", subtype: "success", result: "done" },
        ),
    );
    // Both weekly pools ride out side by side, each named: this is the whole point — a 1% pool must never be
    // able to stand in for a 98% one. ISO reset instants become epoch SECONDS, the unit the rest of the wire uses.
    expect(events).toEqual([
        {
            kind: "account_usage",
            windows: [
                { kind: "five_hour", utilization: 12.4, resetsAt: Date.parse("2026-07-27T18:00:00.000Z") / 1000 },
                { kind: "seven_day", utilization: 98, resetsAt: Date.parse("2026-07-29T09:00:00.000Z") / 1000 },
                { kind: "model:Fable", label: "Fable", utilization: 100, resetsAt: Date.parse("2026-07-29T09:00:00.000Z") / 1000 },
            ],
        },
        { kind: "done" },
    ]);
});

test("a session with no plan limits (API key, or an older CLI) yields no account_usage frame at all", async () => {
    // An empty window list would read as "measured, and you have no limits" — the opposite of unknown.
    const noLimits = await collect(
        request,
        fakeQueryWith({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usageResponse(null) }, { type: "result", subtype: "success" }),
    );
    expect(noLimits).toEqual([{ kind: "done" }]);

    const noMethod = await collect(request, fakeQuery({ type: "result", subtype: "success" }));
    expect(noMethod).toEqual([{ kind: "done" }]);
});

test("a failed usage read cannot fail the turn it was measuring", async () => {
    const events = await collect(
        request,
        fakeQueryWith(
            { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.reject(new Error("control request timed out")) },
            { type: "result", subtype: "success", total_cost_usd: 0.42 },
        ),
    );
    // The answer the user was waiting for is already accounted for; the headroom read is strictly a bonus.
    expect(events).toEqual([{ kind: "usage", costUsd: 0.42 }, { kind: "done" }]);
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

test("without steering the prompt stays a plain string (single-message mode)", async () => {
    let captured: string | AsyncIterable<SDKUserMessage> | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.prompt;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };
    await collect(request, capture);
    expect(captured).toBe("add a /ping route");
});

test("a steering queue switches the turn to streaming input: initial prompt, then injected messages, closed at turn end", async () => {
    let captured: string | AsyncIterable<SDKUserMessage> | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.prompt;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };
    const steering = new SteeringQueue();
    steering.push("also check the tests");
    await collect({ ...request, steering }, capture);
    // runAgent closed the queue when the turn settled, so the input stream terminates after the steer.
    const messages: SDKUserMessage[] = [];
    for await (const message of captured as AsyncIterable<SDKUserMessage>) {
        messages.push(message);
    }
    expect(messages.map((message) => message.message.content)).toEqual(["add a /ping route", "also check the tests"]);
    expect(steering.push("too late")).toBe(false);
});

test("a steered stream survives each turn's result: the queued message's own turn keeps streaming", async () => {
    // The SDK emits one result PER TURN on a streaming input, and a steered message the running turn can't
    // absorb runs as its own follow-up turn — its frames must reach the client instead of dying at result #1.
    const steering = new SteeringQueue();
    steering.push("and 2+6?");
    const events = await collect(
        { ...request, steering },
        fakeQuery(
            { type: "stream_event", session_id: "s", event: { type: "content_block_delta", delta: { type: "text_delta", text: "5" } } },
            { type: "result", subtype: "success", total_cost_usd: 0.1 },
            { type: "stream_event", session_id: "s", event: { type: "content_block_delta", delta: { type: "text_delta", text: "8" } } },
            { type: "result", subtype: "success", total_cost_usd: 0.2 },
        ),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "delta", text: "5" },
        { kind: "usage", costUsd: 0.1 },
        { kind: "delta", text: "8" },
        { kind: "usage", costUsd: 0.2 },
        { kind: "done" },
    ]);
});

test("after the last result a steered stream settles: the grace window closes the queue so the input ends", async () => {
    const steering = new SteeringQueue();
    steering.push("absorbed mid-turn");
    const drained: string[] = [];
    // Like the real SDK, the stream stays open after its result, waiting on the input stream; only the input
    // ending (the grace window closing the queue) lets it finish.
    const sdkLike: QueryFn = async function* (args) {
        yield { type: "result", subtype: "success" } as SDKMessage;
        for await (const message of args.prompt as AsyncIterable<SDKUserMessage>) {
            drained.push(String(message.message.content));
        }
    };
    const events = await collect({ ...request, steering }, sdkLike);
    expect(events).toEqual([{ kind: "done" }]);
    expect(drained).toEqual(["add a /ping route", "absorbed mid-turn"]);
    expect(steering.push("too late")).toBe(false);
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

// A fake whose stream is paired with a supportedCommands(), the shape the real SDK Query satisfies.
const queryWithCommands =
    (commands: unknown, ...messages: unknown[]): QueryFn =>
    (args) =>
        Object.assign(fakeQuery(...messages)(args), {
            supportedCommands: async () => commands as Awaited<ReturnType<NonNullable<AgentQuery["supportedCommands"]>>>,
        });

test("the session's slash commands are published at init, dropping empty argument hints", async () => {
    const events = await collect(
        request,
        queryWithCommands(
            [
                { name: "review", description: "Review a PR", argumentHint: "<pr>" },
                { name: "compact", description: "Compact the context", argumentHint: "" },
            ],
            { type: "system", subtype: "init", session_id: "s", model: "sonnet" },
            { type: "result", subtype: "success" },
        ),
    );
    expect(events).toContainEqual({
        kind: "commands",
        items: [
            { name: "review", description: "Review a PR", hint: "<pr>" },
            { name: "compact", description: "Compact the context" },
        ],
    });
});

test("a commands_changed push republishes the whole list mid-turn", async () => {
    const events = await collect(
        request,
        fakeQuery(
            { type: "system", subtype: "init", session_id: "s", model: "sonnet" },
            {
                type: "system",
                subtype: "commands_changed",
                session_id: "s",
                commands: [{ name: "deploy", description: "Ship it", argumentHint: "" }],
            },
            { type: "result", subtype: "success" },
        ),
    );
    expect(events).toContainEqual({ kind: "commands", items: [{ name: "deploy", description: "Ship it" }] });
});

test("a stream with no command list publishes no commands frame", async () => {
    const events = await collect(request, queryWithCommands([], { type: "system", subtype: "init", session_id: "s", model: "sonnet" }));
    expect(events.some((event) => event.kind === "commands")).toBe(false);
});

test("a failing supportedCommands never breaks the turn", async () => {
    const rejecting: QueryFn = (args) =>
        Object.assign(
            fakeQuery({ type: "system", subtype: "init", session_id: "s", model: "sonnet" }, { type: "result", subtype: "success" })(args),
            {
                supportedCommands: () => Promise.reject(new Error("CLI has no command list")),
            },
        );
    const events = await collect(request, rejecting);
    expect(events.some((event) => event.kind === "commands")).toBe(false);
    expect(events.at(-1)).toEqual({ kind: "done" });
});
