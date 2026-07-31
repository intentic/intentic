import type { Options, PermissionResult, PermissionUpdate, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentReply } from "@intentic/sandbox-contract";
import { afterEach, expect, test, vi } from "vitest";
import { type AgentQuery, mergeHooks, type OauthRecoveryOptions, type QueryFn, runAgent } from "./agent.js";
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

const collect = async (request: Parameters<typeof runAgent>[0], queryFn: QueryFn, usageFetch?: typeof fetch): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of runAgent(request, queryFn, usageFetch)) {
        events.push(event);
    }
    return events;
};

const request = { prompt: "add a /ping route", cwd: "/work", signal: new AbortController().signal };

// Bash routing through bin/tmux-run is decided by whether the wrapper is baked into the image, so a suite run
// INSIDE that image sees a `terminal` frame these event-shape assertions never asked for. Every case below states
// the mode it means: "0" for the shapes that predate tmux routing; agent-terminal-frame.test.ts owns the enabled
// path. Left to the host, the same test asserts different things in an image, a dev checkout, and CI.
const withoutTmux = (): void => {
    vi.stubEnv("INTENTIC_AGENT_TMUX", "0");
};

// Without a vitest config there is no unstubEnvs, so a stub outlives its test and the mode leaks down the file.
afterEach(() => vi.unstubAllEnvs());

test("a turn surfaces session, text deltas, tool actions, and done", async () => {
    withoutTmux();
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
    withoutTmux();
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

/* The env token is a SNAPSHOT taken at spawn: a turn that outlives it — or one caught by an account-wide
 * revocation, which kills tokens that still look valid by the clock — used to die mid-work with
 * "Failed to authenticate. API Error: 401 ...". getOAuthToken is how the CLI asks for a replacement and
 * carries on, and it is the option the VSCode extension's equivalent machinery stands in for. */
test("a native Claude turn hands the SDK a way to re-mint its token mid-turn", async () => {
    let captured: OauthRecoveryOptions | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.options;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    const refreshOauthToken = async (): Promise<string> => "tok-2";
    await collect({ ...request, oauthToken: "tok-1", refreshOauthToken }, capture);
    expect(await captured?.getOAuthToken?.({ signal: new AbortController().signal })).toBe("tok-2");

    // A routed turn authenticates with the translator's own bearer, and the container-env fallback has no
    // refresh token behind it — neither has anything to re-mint, so neither offers the callback.
    captured = undefined;
    await collect({ ...request, baseUrl: "http://127.0.0.1:8788", authToken: "router-key", refreshOauthToken }, capture);
    expect(captured?.getOAuthToken).toBeUndefined();

    captured = undefined;
    await collect(request, capture);
    expect(captured?.getOAuthToken).toBeUndefined();
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

// What the turn hands the SDK. The composition RULES are system-prompt.test.ts's; what matters here is that
// the runner reaches for them at all, and that both shapes survive the trip into the options object.
test("a request with no mode runs Intentic's prompt, and each mode reaches the SDK in its own shape", async () => {
    let captured: Options | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.options;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    // An absent mode is the PRODUCT default, not "whatever the SDK does": a caller that builds a request by hand
    // (the bench) must get the same agent the app ships. And the model has to be TOLD the widgets exist —
    // otherwise it writes "A) … B) …" as prose.
    await collect(request, capture);
    const intentic = captured?.systemPrompt as string;
    expect(intentic).toContain("You are a Claude agent on Claude Agent SDK.");
    expect(intentic).toContain("AskUserQuestion");
    expect(intentic).toContain("TaskCreate");
    expect(intentic).toContain("mcp__web__browser_take_screenshot");

    captured = undefined;
    await collect({ ...request, systemPromptMode: "claude" }, capture);
    const preset = captured?.systemPrompt as { type: string; preset: string; append: string };
    expect(preset).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(preset.append).toContain("AskUserQuestion");

    captured = undefined;
    await collect({ ...request, systemPromptMode: "claude", systemAppend: "## Delegating\nUse codex exec." }, capture);
    const withAppend = captured?.systemPrompt as { append: string };
    expect(withAppend.append).toBe(`${preset.append}\n\n## Delegating\nUse codex exec.`);

    // A custom prompt is handed over as a bare STRING, which is how the SDK is told to drop the preset. Its
    // arrival must take the harness guidance with it — the owner replaced the prompt, not merely prefixed it.
    captured = undefined;
    await collect({ ...request, systemPromptMode: "custom", systemPrompt: "You are a release-notes writer." }, capture);
    expect(captured?.systemPrompt).toBe("You are a release-notes writer.");
});

// Two producers register PreToolUse:Bash — the tmux wrapper and the install steer. Merged with a plain object
// spread the second silently wins the key and the first never fires, taking the live terminal panel with it.
// (Driven directly: tmuxRunEnabled() needs /usr/local/bin/tmux-run, which exists in the image, not on a host.)
test("hook sets are concatenated per event, not overwritten", () => {
    const a = { PreToolUse: [{ matcher: "Bash", hooks: [] }], PostToolUse: [{ matcher: "Edit", hooks: [] }] };
    const b = { PreToolUse: [{ matcher: "Bash", hooks: [] }] };
    const merged = mergeHooks(a, b);
    expect(merged.PreToolUse).toHaveLength(2);
    expect(merged.PostToolUse).toHaveLength(1);
});

test("every turn registers the install steer and the post-edit diagnostics hook", async () => {
    let captured: Options | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.options;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect(request, capture);
    expect(captured?.hooks?.PreToolUse?.some((matcher) => matcher.matcher === "Bash")).toBe(true);
    expect(captured?.hooks?.PostToolUse?.some((matcher) => matcher.matcher === "Edit|Write")).toBe(true);
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
): Promise<{ result: PermissionResult; card: AgentEvent; frames: AgentEvent[] }> => {
    let result: PermissionResult | undefined;
    let card: AgentEvent | undefined;
    const frames: AgentEvent[] = [];
    const query: QueryFn = async function* (args) {
        const gate = args.options.canUseTool!;
        result = await gate(call.tool, call.input ?? {}, { signal: turn.signal, suggestions: call.suggestions } as never);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };
    for await (const event of runAgent(turn, query)) {
        frames.push(event);
        if (event.kind === "permission" || event.kind === "plan") {
            card = event;
            resolveRequest(answer(event));
        }
    }
    return { result: result!, card: card!, frames };
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

test("a decided card is recorded in the frame log, so a replay freezes it instead of re-offering it", async () => {
    // The turn's frames are what a reload replays and what a second window renders. A card whose answer never
    // entered the log comes back live there — buttons on a requestId this daemon no longer holds.
    const { card, frames } = await decide({ ...request, permissionMode: "default" }, { tool: "WebFetch" }, (event) => ({
        kind: "permission",
        requestId: event.requestId,
        decision: "once",
    }));

    expect(frames.filter((frame) => frame.kind === "resolved")).toEqual([
        { kind: "resolved", requestId: card.requestId, reply: { kind: "permission", requestId: card.requestId, decision: "once" } },
    ]);
    // ...and it lands after the card it settles, so replaying in order never freezes a card that isn't there yet.
    expect(frames.findIndex((frame) => frame.kind === "resolved")).toBeGreaterThan(frames.findIndex((frame) => frame.kind === "permission"));
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
                "Claude usage limit reached — this account's allowance is exhausted, not a provider outage. Send again once it resets to carry on from here.",
        },
        { kind: "done" },
    ]);
});

test("a non-rate-limit assistant error with no explanation falls back to its bare category", async () => {
    const events = await collect(request, fakeQuery({ type: "assistant", session_id: "s", error: "unknown", message: { content: [] } }));
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", message: "agent error: unknown" }, { kind: "done" }]);
});

/* THE PROVIDER'S OWN FAILURES, read from the CATEGORY rather than the sentence. The harness files every 5xx, every
 * 529 at capacity and every dropped socket as `server_error`, and a pre-retry capacity refusal as `overloaded`;
 * both mean the request is worth making again, which is the one claim the auto-resume has to be right about. The
 * wording changes with every CLI release, so classifying on it would break silently — these two tests are what
 * pins that. */
test("a server_error is coded as a provider outage, keeping the provider's own sentence", async () => {
    const outage = "API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "server_error", message: { content: [{ type: "text", text: outage }] } }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", code: "provider-outage", message: outage }, { kind: "done" }]);
});

test("a 529 at capacity is the same condition as a 500 — one code covers both", async () => {
    const overloaded = "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "overloaded", message: { content: [{ type: "text", text: overloaded }] } }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", code: "provider-outage", message: overloaded }, { kind: "done" }]);
});

// The turn is still alive here — the harness lost a request and is retrying it in place. It surfaces because the
// retry budget is long enough (CLAUDE_CODE_RETRY_WATCHDOG) that the silence would otherwise read as a hang, and
// the user's answer to a hang is Stop, which is the only thing that loses the work.
test("an in-turn retry surfaces as a waiting status with its own next-attempt clock, not an error", async () => {
    const events = await collect(
        request,
        fakeQuery({
            type: "system",
            subtype: "api_retry",
            session_id: "s",
            attempt: 3,
            max_retries: 300,
            retry_delay_ms: 45_000,
            error_status: 529,
            error: "overloaded",
        }),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "provider_retry", attempt: 3, maxAttempts: 300, nextAttemptAt: expect.any(Number), status: 529 },
        { kind: "done" },
    ]);
});

// A transport failure never got a response, so there is no status to name — the frame carries the wait alone
// rather than inventing a code the client would render as if the provider had spoken.
test("a retry with no HTTP status behind it omits the status instead of faking one", async () => {
    const events = await collect(
        request,
        fakeQuery({
            type: "system",
            subtype: "api_retry",
            session_id: "s",
            attempt: 1,
            max_retries: 300,
            retry_delay_ms: 1_000,
            error_status: null,
            error: "server_error",
        }),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "provider_retry", attempt: 1, maxAttempts: 300, nextAttemptAt: expect.any(Number) },
        { kind: "done" },
    ]);
});

test("a usage-limit retry parks the turn at its reset instead of masquerading as a provider outage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T20:00:00.000Z"));
    try {
        const events = await collect(
            request,
            fakeQuery(
                {
                    type: "system",
                    subtype: "api_retry",
                    session_id: "s",
                    attempt: 1,
                    max_retries: 300,
                    retry_delay_ms: 15 * 60_000,
                    error_status: 429,
                    error: "rate_limit",
                },
                // Returning on the retry closes the SDK iterator; the exhausted turn does not keep spinning.
                { type: "stream_event", session_id: "s", event: { type: "content_block_delta", delta: { type: "text_delta", text: "never" } } },
            ),
        );
        expect(events).toEqual([
            { kind: "session", sessionId: "s" },
            {
                kind: "error",
                code: "rate_limit",
                message: expect.stringContaining("allowance is exhausted"),
                resetsAt: Date.parse("2026-07-30T20:15:00.000Z") / 1000,
            },
            { kind: "done" },
        ]);
    } finally {
        vi.useRealTimers();
    }
});

/* THE ROUTED HALF OF THE SAME FRAME, and the reason `allowance` exists at all.
 *
 * A Google turn runs Claude Opus through Antigravity on the Claude Code harness, so everything the harness says
 * about the 429 is about the wrong vendor: it names Anthropic, and CLIProxyAPI sends no Retry-After, leaving
 * `retry_delay_ms` as the SDK's own 620ms-and-doubling backoff. Reading that as an instant is what put "Resets
 * 5:32 PM" — the moment of the failure — under a Google weekly quota that was five days out. Both halves are
 * asserted here: the delay is IGNORED (the reopen instant wins) and the vendor is the one that refused. */
test("a routed usage-limit retry names the vendor that refused and takes its reset from that vendor's quota, not the harness backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T15:32:33.000Z"));
    const reopensAt = Date.parse("2026-08-06T09:57:46.000Z") / 1000;
    try {
        const events = await collect(
            { ...request, allowance: { vendor: "Google", reopensAt: async () => reopensAt } },
            fakeQuery({
                type: "system",
                subtype: "api_retry",
                session_id: "s",
                attempt: 1,
                max_retries: 300,
                retry_delay_ms: 620,
                error_status: 429,
                error: "rate_limit",
            }),
        );
        expect(events).toEqual([
            { kind: "session", sessionId: "s" },
            { kind: "error", code: "rate_limit", message: expect.stringContaining("Google usage limit reached"), resetsAt: reopensAt },
            { kind: "done" },
        ]);
    } finally {
        vi.useRealTimers();
    }
});

// Nothing on file beats a number we made up: the client renders a limit with no reset as a plain notice, which
// is honest, where `now + backoff` reads as "already reset" and invites an immediate retry into a closed window.
test("a routed usage-limit retry with no quota reading on file carries no reset at all", async () => {
    const events = await collect(
        { ...request, allowance: { vendor: "Google", reopensAt: async () => undefined } },
        fakeQuery({
            type: "system",
            subtype: "api_retry",
            session_id: "s",
            attempt: 1,
            max_retries: 300,
            retry_delay_ms: 620,
            error_status: 429,
            error: "rate_limit",
        }),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", code: "rate_limit", message: expect.stringContaining("Google usage limit reached") },
        { kind: "done" },
    ]);
});

// The CLI files a mid-session limit hit under a non-rate_limit category, with only the sentence saying what
// happened ("You've hit your session limit · resets …"). The sentence is kept — it names the reset, our canned
// line doesn't — but the code makes it the same condition as the assistant-error rate_limit above.
test("a usage-limit sentence under another error category is classified as rate_limit, keeping its own text", async () => {
    const limitText = "You've hit your session limit · resets 1:40pm (UTC)";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "unknown", message: { content: [{ type: "text", text: limitText }] } }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", code: "rate_limit", message: limitText }, { kind: "done" }]);
});

// 'unknown' is the SDK's catch-all for every 4xx, so the category names nothing the user can fix; the API's own
// sentence rides in the synthetic message's text block and is the whole value of the frame.
test("an API error surfaces the API's own sentence, not the SDK's error category", async () => {
    const apiError = "API Error: 400 output_config.effort 'max' is not supported when thinking is disabled on this model.";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "unknown", message: { content: [{ type: "text", text: apiError }] } }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", message: apiError }, { kind: "done" }]);
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

// The turn ran on a stored account's OAuth token, so its plan limits are readable at settle.
const oauthRequest = { ...request, oauthToken: "oat-1" };
// A fake of the OAuth usage endpoint: the daemon reads it directly because the CLI only reports rate limits
// for a profile it signed in itself, which a token-authenticated daemon turn never is.
const usageEndpoint = (body: unknown, ok = true): typeof fetch =>
    (() => Promise.resolve({ ok, json: () => Promise.resolve(body) })) as unknown as typeof fetch;

test("a settled turn re-reads EVERY plan-limit pool, not just whichever one was binding", async () => {
    const events = await collect(
        oauthRequest,
        fakeQuery({ type: "result", subtype: "success", result: "done" }),
        usageEndpoint({
            five_hour: { utilization: 12.4, resets_at: "2026-07-27T18:00:00.000Z" },
            seven_day: { utilization: 98, resets_at: "2026-07-29T09:00:00.000Z" },
            // A pool the plan has but the provider has no reading for — dropped, not shown at 0%.
            seven_day_opus: { utilization: null, resets_at: null },
        }),
    );
    // Both pools ride out side by side, each named: this is the whole point — a 1% pool must never be able to
    // stand in for a 98% one. ISO reset instants become epoch SECONDS, the unit the rest of the wire uses.
    expect(events).toEqual([
        {
            kind: "account_usage",
            windows: [
                { kind: "five_hour", utilization: 12.4, resetsAt: Date.parse("2026-07-27T18:00:00.000Z") / 1000 },
                { kind: "seven_day", utilization: 98, resetsAt: Date.parse("2026-07-29T09:00:00.000Z") / 1000 },
            ],
        },
        { kind: "done" },
    ]);
});

test("a turn with no plan limits to read yields no account_usage frame at all", async () => {
    // An empty window list would read as "measured, and you have no limits" — the opposite of unknown.
    // The endpoint refusing the credential (an API key has no plan):
    const refused = await collect(oauthRequest, fakeQuery({ type: "result", subtype: "success" }), usageEndpoint({}, false));
    expect(refused).toEqual([{ kind: "done" }]);

    // No OAuth token at all (endpoint/container-env turn): the endpoint is never even asked.
    const unattributed = await collect(request, fakeQuery({ type: "result", subtype: "success" }), () => {
        throw new Error("no credential to read usage with");
    });
    expect(unattributed).toEqual([{ kind: "done" }]);
});

test("a failed usage read cannot fail the turn it was measuring", async () => {
    const events = await collect(oauthRequest, fakeQuery({ type: "result", subtype: "success", total_cost_usd: 0.42 }), (() =>
        Promise.reject(new Error("usage endpoint timed out"))) as unknown as typeof fetch);
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

/* A command the CLI answers ITSELF bypasses the model, so nothing else on the stream carries what it said.
 * Dropping this message (which the translation did) made every such command look broken — the turn ended with
 * the user's own echo and silence, whatever the command had actually replied. */
test("output from a locally-answered command reaches the transcript as assistant text", async () => {
    const events = await collect(
        request,
        fakeQuery(
            { type: "system", subtype: "init", session_id: "s", model: "sonnet" },
            {
                type: "system",
                subtype: "local_command_output",
                session_id: "s",
                content: "<local-command-stdout>Session: 12k tokens</local-command-stdout>",
            },
            { type: "result", subtype: "success" },
        ),
    );
    expect(events).toContainEqual({ kind: "delta", text: "Session: 12k tokens" });
    expect(events).toContainEqual({ kind: "text_end" });
});

/* The one local-command answer that means the message was thrown away rather than acted on: the CLI claimed
 * the leading `/`, found no such command, and discarded the rest. Coded, not narrated — the client holds the
 * text back rather than leaving the user to notice the silence and retype (conversation.ts). */
test("an unknown command is an error the client can act on, naming the token that ate the message", async () => {
    const events = await collect(
        request,
        fakeQuery(
            { type: "system", subtype: "init", session_id: "s", model: "sonnet" },
            {
                type: "system",
                subtype: "local_command_output",
                session_id: "s",
                content: "<local-command-stdout>Unknown command: /workspace</local-command-stdout>",
            },
            { type: "result", subtype: "success" },
        ),
    );
    const error = events.find((event) => event.kind === "error");
    expect(error?.code).toBe("unknown-command");
    expect(error?.message).toContain("/workspace");
    // No assistant bubble for it: "Unknown command" is not something the agent said.
    expect(events.some((event) => event.kind === "delta")).toBe(false);
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
