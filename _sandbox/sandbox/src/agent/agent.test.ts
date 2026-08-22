import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { Options, PermissionResult, PermissionUpdate, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentReply } from "@intentic/sandbox-contract";
import { afterEach, expect, test, vi } from "vitest";
import { mergeHooks, type OauthRecoveryOptions, runAgent } from "./agent.js";
import type { AgentQuery, QueryFn } from "./sdk-stream.js";
import { resolveRequest } from "./agent-requests.js";
import { SteeringQueue } from "./agent-steering.js";
import { noteDelegation, resetSubagents, settleDelegation } from "./subagents.js";

// Build a fake QueryFn yielding canned SDK messages (cast to SDKMessage: tests exercise only the fields
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

// browserOutputDir present: the shape of a browser-carrying turn (the standard image's ordinary case), its
// absence is the core-image signal that strips the browser guidance, asserted in system-prompt.test.ts.
const request = {
    prompt: "add a /ping route",
    cwd: WORKSPACE_ROOT,
    signal: new AbortController().signal,
    browserOutputDir: `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser`,
};

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
            // The tool_use block's own start/stop must not close a prose bubble: only a text block's does.
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
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    // IS_SANDBOX is always set so the CLI accepts --dangerously-skip-permissions under root.
    await collect({ ...request, oauthToken: "tok-xyz" }, capture);
    expect(captured.at(-1)?.env?.["IS_SANDBOX"]).toBe("1");
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("tok-xyz");

    await collect(request, capture);
    expect(captured.at(-1)?.env?.["IS_SANDBOX"]).toBe("1");
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
});

/* THE ABSENCE IS THE LOAD-BEARING HALF. The three delegation ceilings are read inside the CLI, and each has its
 * own default there: one of which (the nesting cap) the CLI resolves from its own remote config rather than a
 * constant. So a turn that says nothing must set nothing: emitting today's default back as an env var would pin
 * a number that is meant to be able to move, and it would do it for every sandbox that never opened the group.
 * turn-plan.ts is what decides "the owner moved this"; this asserts the half of the deal that lives here. */
test("the delegation ceilings reach the CLI only where the turn names one", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect(request, capture);
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"]).toBeUndefined();
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"]).toBeUndefined();
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"]).toBeUndefined();

    // Each is independent: a raised concurrency cap must not drag the other two into the environment with it.
    await collect({ ...request, subagentsAtOnce: 50 }, capture);
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"]).toBe("50");
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"]).toBeUndefined();
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"]).toBeUndefined();

    await collect({ ...request, subagentsAtOnce: 40, subagentsPerTurn: 500, subagentDepth: 5 }, capture);
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"]).toBe("40");
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"]).toBe("500");
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"]).toBe("5");
});

/* The env token is a SNAPSHOT taken at spawn: a turn that outlives it, or one caught by an account-wide
 * revocation, which kills tokens that still look valid by the clock: used to die mid-work with
 * "Failed to authenticate. API Error: 401 ...". getOAuthToken is how the CLI asks for a replacement and
 * carries on, and it is the option the VSCode extension's equivalent machinery stands in for. */
test("a native Claude turn hands the SDK a way to re-mint its token mid-turn", async () => {
    const captured: OauthRecoveryOptions[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    const refreshOauthToken = async (): Promise<string> => "tok-2";
    await collect({ ...request, oauthToken: "tok-1", refreshOauthToken }, capture);
    expect(await captured.at(-1)?.getOAuthToken?.({ signal: new AbortController().signal })).toBe("tok-2");

    // A routed turn authenticates with the translator's own bearer, and the container-env fallback has no
    // refresh token behind it: neither has anything to re-mint, so neither offers the callback.
    await collect({ ...request, baseUrl: "http://127.0.0.1:8788", authToken: "router-key", refreshOauthToken }, capture);
    expect(captured.at(-1)?.getOAuthToken).toBeUndefined();

    await collect(request, capture);
    expect(captured.at(-1)?.getOAuthToken).toBeUndefined();
});

test("a custom endpoint points the SDK at ANTHROPIC_BASE_URL and withholds the subscription OAuth token", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    // A routed turn (codex/grok under the Claude Code harness) carries baseUrl + authToken. The Anthropic
    // subscription token must NEVER leave for a foreign endpoint: even if an oauthToken is also present, baseUrl
    // wins and CLAUDE_CODE_OAUTH_TOKEN is dropped.
    await collect({ ...request, baseUrl: "http://127.0.0.1:8788", authToken: "router-key", oauthToken: "tok-xyz", model: "gpt-5-codex" }, capture);
    expect(captured.at(-1)?.env?.["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:8788");
    expect(captured.at(-1)?.env?.["ANTHROPIC_AUTH_TOKEN"]).toBe("router-key");
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    expect(captured.at(-1)?.model).toBe("gpt-5-codex");
});

// What the turn hands the SDK. The composition RULES are system-prompt.test.ts's; what matters here is that
// the runner reaches for them at all, and that both shapes survive the trip into the options object.
test("a request with no mode runs Intentic's prompt, and each mode reaches the SDK in its own shape", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    // An absent mode is the PRODUCT default, not "whatever the SDK does": a caller that builds a request by hand
    // (the bench) must get the same agent the app ships. And the model has to be TOLD the widgets exist:
    // otherwise it writes "A) … B) …" as prose.
    await collect(request, capture);
    const intentic = captured.at(-1)?.systemPrompt as string;
    expect(intentic).toContain("You are a Claude agent on Claude Agent SDK.");
    expect(intentic).toContain("AskUserQuestion");
    expect(intentic).toContain("TaskCreate");
    expect(intentic).toContain("mcp__web__browser_take_screenshot");

    await collect({ ...request, systemPromptMode: "claude" }, capture);
    const preset = captured.at(-1)?.systemPrompt as { type: string; preset: string; append: string };
    expect(preset).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(preset.append).toContain("AskUserQuestion");

    await collect({ ...request, systemPromptMode: "claude", systemAppend: "## Delegating\nUse codex exec." }, capture);
    const withAppend = captured.at(-1)?.systemPrompt as { append: string };
    expect(withAppend.append).toBe(`${preset.append}\n\n## Delegating\nUse codex exec.`);

    // A custom prompt is handed over as a bare STRING, which is how the SDK is told to drop the preset. Its
    // arrival must take the harness guidance with it: the owner replaced the prompt, not merely prefixed it.
    await collect({ ...request, systemPromptMode: "custom", systemPrompt: "You are a release-notes writer." }, capture);
    expect(captured.at(-1)?.systemPrompt).toBe("You are a release-notes writer.");
});

// Two producers register PreToolUse:Bash: the tmux wrapper and the install steer. Merged with a plain object
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
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect(request, capture);
    expect(captured.at(-1)?.hooks?.PreToolUse?.some((matcher) => matcher.matcher === "Bash")).toBe(true);
    expect(captured.at(-1)?.hooks?.PostToolUse?.some((matcher) => matcher.matcher === "Edit|Write")).toBe(true);
});

test("every turn wires the ui ask server, the AskUserQuestion alias, and the permission gate", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    // The autonomous posture is the one the composer defaults away from plan mode into: it used to get no
    // question tool at all, which is why the model fell back to prose options.
    await collect(request, capture);
    expect(captured.at(-1)?.mcpServers?.["ui"]).toBeDefined();
    // Two aliases now: the ask card's, and the JS execution backend's plain name (execution/js-tool.ts).
    expect(captured.at(-1)?.toolAliases).toEqual({ AskUserQuestion: "mcp__ui__ask", Code: "mcp__code__run" });
    expect(captured.at(-1)?.canUseTool).toBeTypeOf("function");
    expect(captured.at(-1)?.permissionMode).toBe("bypassPermissions");
    expect(captured.at(-1)?.allowDangerouslySkipPermissions).toBe(true);
});

/* The JS execution backend mounts from its own request field, and ONLY from it: no plan (a card that switched
 * it off, a runtime that doesn't host it: turn-plan decides both) means no server, which is the absence the
 * persona layer promises. */
test("the code server rides the jsExecution field: present with a plan, absent without one", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect(request, capture);
    expect(captured.at(-1)?.mcpServers?.["code"]).toBeUndefined();

    const jsExecution = { cwd: WORKSPACE_ROOT, env: {}, readRoots: [WORKSPACE_ROOT], writeRoots: [WORKSPACE_ROOT], allowSpawn: true };
    await collect({ ...request, jsExecution }, capture);
    expect(captured.at(-1)?.mcpServers?.["code"]).toBeDefined();
});

test("the request's tools become remote http MCP servers alongside the ui server, in every mode", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };
    const obs = { type: "http", url: "https://signoz.example.com/mcp", alwaysLoad: true, headers: { Authorization: "Bearer tok" } };
    const tools = [{ name: "obs", url: "https://signoz.example.com/mcp", token: "tok" }];

    await collect({ ...request, tools }, capture);
    expect(captured.at(-1)?.mcpServers?.["obs"]).toEqual(obs);
    expect(captured.at(-1)?.mcpServers?.["ui"]).toBeDefined();

    await collect({ ...request, permissionMode: "plan" as const, tools }, capture);
    expect(captured.at(-1)?.mcpServers?.["obs"]).toEqual(obs);
    expect(captured.at(-1)?.mcpServers?.["ui"]).toBeDefined();
    expect(captured.at(-1)?.permissionMode).toBe("plan");
    // The flag rides every launch: it legalises bypassPermissions without activating it, and a plan turn
    // NEEDS it: approval setModes to POST_PLAN_MODE, which the CLI refuses on a session launched without it.
    expect(captured.at(-1)?.allowDangerouslySkipPermissions).toBe(true);
});

test("plugin checkout dirs are passed to the SDK as local plugins", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect({ ...request, plugins: [`${WORKSPACE_ROOT}/${STATE_DIR}/records/plugins/x`] }, capture);
    expect(captured.at(-1)?.plugins).toEqual([{ type: "local", path: "/work/.intentic/records/plugins/x" }]);

    await collect(request, capture);
    expect(captured.at(-1)?.plugins).toBeUndefined();
});

// Drive the permission gate end-to-end: the fake query calls `canUseTool` mid-stream, the test answers the card
// the way the browser does (POST /agent/reply → resolveRequest), and the gate's decision comes back to assert on.
type DecidableCard = Extract<AgentEvent, { kind: "permission" | "plan" }>;

const decide = async (
    turn: Parameters<typeof runAgent>[0],
    call: { tool: string; input?: Record<string, unknown>; suggestions?: PermissionUpdate[] },
    answer: (event: DecidableCard) => AgentReply,
): Promise<{ result: PermissionResult; card: DecidableCard; frames: AgentEvent[] }> => {
    let result: PermissionResult | null | undefined;
    let card: DecidableCard | undefined;
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
    // The SDK's own suggestion is command-scoped: the next command would ask again, so the tool-wide rule the
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
    // entered the log comes back live there: buttons on a requestId this daemon no longer holds.
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

test("an approved plan executes with permissions bypassed, whatever the turn planned from", async () => {
    const approve = (event: DecidableCard): AgentReply => ({ kind: "plan", requestId: event.requestId, approve: true });

    /* Approving is the user reading what the agent intends to do and saying yes to all of it, so the posture the
     * turn PLANNED from is not a ceiling on the plan it approved, and the container is the isolation boundary
     * either way. The shape this replaces restored the starting posture and floored a plan-mode turn on
     * 'acceptEdits', so approving a plan in the mode the user picked TO SEE ONE bought them a permission card
     * for `git log`. */
    for (const permissionMode of ["plan", "default", "acceptEdits", "bypassPermissions"] as const) {
        const { result, frames } = await decide({ ...request, permissionMode }, { tool: "ExitPlanMode", input: { plan: "# Plan" } }, approve);
        expect(result).toMatchObject({ updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] });
        // ...and the composer's pill hears about it, so it never claims the turn is still planning.
        expect(frames).toContainEqual({ kind: "mode", mode: "bypassPermissions" });
    }
});

/* THE REBASE A CARD SETTLES INTO. A plan approval is the longest park of the three cards and the one followed
 * by the most writing, so the branch is put back on today's main line before the agent starts building against
 * a tree it planned from. The route owns the git; these cases own WHEN it is asked for, which is the part that
 * can quietly go wrong: fire on a rejection and the daemon rewrites a branch whose turn the user just stopped;
 * fire under a running command and the ground moves beneath a build nobody is watching. */
// The one thing the route hands back: the summary line the reader gets. The model is told nothing, a rebase it
// hears about is a rebase it goes and verifies, and a clean one never had anything to find (turn-preamble.ts).
const parkedSync = { kind: "worktree" as const, branch: "agent/c1", base: "abc1234", sync: { commits: 2, blocked: [] } };

test("an approved plan rebases the branch and announces it to the transcript alone", async () => {
    withoutTmux();
    const steering = new SteeringQueue();
    let calls = 0;
    const { frames } = await decide(
        {
            ...request,
            steering,
            resync: async () => {
                calls += 1;
                return parkedSync;
            },
        },
        { tool: "ExitPlanMode", input: { plan: "# Plan" } },
        (event) => ({ kind: "plan", requestId: event.requestId, approve: true }),
    );

    expect(calls).toBe(1);
    // The transcript hears it where it happened: after the card it settles, not at the top of the turn.
    expect(frames.filter((frame) => frame.kind === "worktree")).toEqual([parkedSync]);
    expect(frames.findIndex((frame) => frame.kind === "worktree")).toBeGreaterThan(frames.findIndex((frame) => frame.kind === "resolved"));
    // Nothing is disclosed to the reader as words the model was given, because it was given none...
    expect(frames.some((frame) => frame.kind === "preamble")).toBe(false);
    // ...and the steering queue, the only channel an approved plan has back to the model, stays empty.
    expect(steering.delivered).toBe(0);
});

// A rejected plan stops the turn. Rewriting the branch there moves work the user just declined to continue.
test("a rejected plan leaves the branch alone", async () => {
    withoutTmux();
    let calls = 0;
    await decide(
        {
            ...request,
            resync: async () => {
                calls += 1;
                return parkedSync;
            },
        },
        { tool: "ExitPlanMode", input: { plan: "# Plan" } },
        (event) => ({ kind: "plan", requestId: event.requestId, approve: false, feedback: "not yet" }),
    );

    expect(calls).toBe(0);
});

// A branch already on today's main line is the ordinary answer: no frame, and nothing said to anyone.
test("an approved plan on a current branch says nothing", async () => {
    withoutTmux();
    const steering = new SteeringQueue();
    const { frames } = await decide(
        { ...request, steering, resync: async () => undefined },
        { tool: "ExitPlanMode", input: { plan: "# Plan" } },
        (event) => ({
            kind: "plan",
            requestId: event.requestId,
            approve: true,
        }),
    );

    expect(frames.some((frame) => frame.kind === "worktree")).toBe(false);
    expect(steering.delivered).toBe(0);
});

/* THE QUIET-WORKTREE GATE, subagent half. The model is parked on the card; its children are not, and a
 * subagent does its own editing. Rebasing under one swaps files mid-read and sweeps a half-written file into
 * the commit the rebase takes first: the two failures that do not announce themselves, which is the whole
 * reason this pass is worth skipping rather than forcing. (The shell half is agent-terminals.integration.test.) */
test("a subagent still running holds the rebase off", async () => {
    withoutTmux();
    resetSubagents();
    const conversationId = "c-parked";
    let calls = 0;
    noteDelegation(
        { conversationId, cwd: WORKSPACE_ROOT, sessionId: undefined, subagentsDir: undefined },
        { id: "bash-1", command: "codex exec --sandbox danger-full-access --cd /work 'port the tests'", background: false },
    );

    await decide(
        {
            ...request,
            conversationId,
            permissionMode: "bypassPermissions" as const,
            resync: async () => {
                calls += 1;
                return parkedSync;
            },
        },
        { tool: "ExitPlanMode", input: { plan: "# Plan" } },
        (event) => ({ kind: "plan", requestId: event.requestId, approve: true }),
    );

    expect(calls).toBe(0);
    // Settled, and the same approval now takes the rebase it just skipped.
    settleDelegation("bash-1", { failed: false, output: "done" });
    await decide(
        {
            ...request,
            conversationId,
            permissionMode: "bypassPermissions" as const,
            resync: async () => {
                calls += 1;
                return parkedSync;
            },
        },
        { tool: "ExitPlanMode", input: { plan: "# Plan" } },
        (event) => ({ kind: "plan", requestId: event.requestId, approve: true }),
    );
    expect(calls).toBe(1);
});

/* The answer outranks the rebase: asserted against a resync that THROWS rather than one that behaves, because
 * the harness does not own that callback and a card must not die from a side channel. The person has already
 * clicked: a git fault reaching this far would come back to them as a plan approval that did not take, losing
 * the one thing the exchange was for to report a branch that simply stayed where it was. */
test("a plan approval survives a sync that fails", async () => {
    withoutTmux();
    const { result } = await decide(
        {
            ...request,
            permissionMode: "bypassPermissions" as const,
            resync: async () => {
                throw new Error("git exploded");
            },
        },
        { tool: "ExitPlanMode", input: { plan: "# Plan" } },
        (event) => ({ kind: "plan", requestId: event.requestId, approve: true }),
    );

    expect(result).toMatchObject({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "bypassPermissions" }] });
});

// The permission card is deliberately NOT a sync point: its tool call was computed against the tree as it was,
// and moving a file under an approved Edit turns the user's "yes" into a failure they authored.
test("a permission answer never moves the branch", async () => {
    withoutTmux();
    let calls = 0;
    await decide(
        {
            ...request,
            permissionMode: "default" as const,
            resync: async () => {
                calls += 1;
                return parkedSync;
            },
        },
        { tool: "Bash", input: { command: "pnpm test" } },
        (event) => ({ kind: "permission", requestId: event.requestId, decision: "once" }),
    );

    expect(calls).toBe(0);
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
                "Claude usage limit reached: this account's allowance is exhausted, not a provider outage. Send again once it resets to carry on from here.",
        },
        { kind: "done" },
    ]);
});

test("a non-rate-limit assistant error with no explanation falls back to its bare category", async () => {
    const events = await collect(request, fakeQuery({ type: "assistant", session_id: "s", error: "unknown", message: { content: [] } }));
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", message: "agent error: unknown" }, { kind: "done" }]);
});

/* A SEAT THE ORGANIZATION TOOK AWAY: the failure that had no code at all, and so left no trace anywhere but the
 * chat that provoked it. It arrives as an `unknown` category carrying Anthropic's own prose, matching neither the
 * usage-limit prefixes nor the CLI's "Failed to authenticate", so it fell through to a bare uncoded error: no
 * refusal was filed against the account, and the picker went on drawing a fresh green ring over an account that
 * refused every turn (its token authenticates and its plan publishes pools throughout).
 *
 * Its own code rather than claude-token-refused, which is the branch it sits directly above: that one arms a
 * re-mint-and-re-run, and no token this daemon can mint restores a seat. Coding it there would have spent a
 * retry, failed identically, and ended by asking the user to reconnect an account that was never disconnected. */
test("a revoked Claude Code seat is coded as its own refusal, not as a credential to re-mint", async () => {
    const seat =
        "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "unknown", message: { content: [{ type: "text", text: seat }] } }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", code: "claude-not-entitled", message: seat }, { kind: "done" }]);
});

/* A SPENT PLAN THAT ARRIVES DRESSED AS A DEAD CREDENTIAL: the routed providers' version of the seat above,
 * sitting directly above the same branch and for the same reason.
 *
 * Kimi refuses a spent Kimi Code plan with `403 You've reached your usage limit for this billing cycle`, and a
 * 403 is what the CLI prints its "Failed to authenticate" prefix over. So it satisfied isAuthFailureText and
 * went out as a refused credential, which the client answers with the reconnect banner: a fix for a condition
 * the user does not have. The account authenticates perfectly; its quota is simply gone until the cycle turns,
 * and no reconnect brings that back.
 *
 * Coded as the limit it is, carrying the provider's OWN sentence (which names the remedy: buy more, or wait)
 * rather than the canned Claude line, because on a routed turn Anthropic had no part in the refusal. */
test("a routed provider's spent plan is coded as a limit, not as a credential to reconnect", async () => {
    const kimi =
        "Failed to authenticate. API Error: 403 You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "unknown", message: { content: [{ type: "text", text: kimi }] } }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", code: "rate_limit", message: kimi }, { kind: "done" }]);
});

// The branch below it still stands: a token that was actually revoked says nothing about an allowance, and must
// keep arming the re-mint-and-resume rather than parking the turn on a reset that is never coming.
test("a genuinely revoked credential still reads as one to re-mint", async () => {
    const revoked = "Failed to authenticate. API Error: 401 OAuth access token has been revoked";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "unknown", message: { content: [{ type: "text", text: revoked }] } }),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", code: "claude-token-refused", message: revoked },
        { kind: "done" },
    ]);
});

/* THE PROVIDER'S OWN FAILURES, read from the CATEGORY rather than the sentence. The harness files every 5xx, every
 * 529 at capacity and every dropped socket as `server_error`, and a pre-retry capacity refusal as `overloaded`;
 * both mean the request is worth making again, which is the one claim the auto-resume has to be right about. The
 * wording changes with every CLI release, so classifying on it would break silently: these two tests are what
 * pins that. */
test("a server_error is coded as a provider outage, keeping the provider's own sentence", async () => {
    const outage = "API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "server_error", message: { content: [{ type: "text", text: outage }] } }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", code: "provider-outage", message: outage }, { kind: "done" }]);
});

test("a 529 at capacity is the same condition as a 500: one code covers both", async () => {
    const overloaded = "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "overloaded", message: { content: [{ type: "text", text: overloaded }] } }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", code: "provider-outage", message: overloaded }, { kind: "done" }]);
});

// The turn is still alive here: the harness lost a request and is retrying it in place. It surfaces because the
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
        // 300 is the harness's budget; 8 is the one the daemon will honour, and the wire carries the honoured one.
        { kind: "provider_retry", attempt: 3, maxAttempts: 8, nextAttemptAt: expect.any(Number), status: 529 },
        { kind: "done" },
    ]);
});

// A transport failure never got a response, so there is no status to name: the frame carries the wait alone
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
        { kind: "provider_retry", attempt: 1, maxAttempts: 8, nextAttemptAt: expect.any(Number) },
        { kind: "done" },
    ]);
});

/* THE STORM THAT IS NOT CLEARING. The harness would keep asking three hundred times, which for a provider that
 * refuses every request is a card in the Active lane under a "Working…" spinner for the rest of the afternoon.
 * The turn ends on the provider's own condition instead, which is what puts the waiting in the hands of the
 * breaker and the resume scheduler, and the card where a reader can see it. */
test("a retry storm past the in-turn bound ends the turn as an outage rather than spinning on", async () => {
    const events = await collect(
        request,
        fakeQuery(
            {
                type: "system",
                subtype: "api_retry",
                session_id: "s",
                attempt: 8,
                max_retries: 300,
                retry_delay_ms: 1_000,
                error_status: 500,
                error: "server_error",
            },
            // Never reached: the stream is over, which is the whole point, the CLI is not left retrying behind a
            // card that has already settled.
            { type: "stream_event", session_id: "s", event: { type: "content_block_delta", delta: { type: "text_delta", text: "never" } } },
        ),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", code: "provider-outage", message: expect.stringContaining("refused 8 requests in a row (HTTP 500)") },
        { kind: "done" },
    ]);
});

test("a retry storm short of the bound is still absorbed in place: the turn keeps its session and says so", async () => {
    const events = await collect(
        request,
        fakeQuery({
            type: "system",
            subtype: "api_retry",
            session_id: "s",
            attempt: 7,
            max_retries: 300,
            retry_delay_ms: 1_000,
            error_status: 500,
            error: "server_error",
        }),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "provider_retry", attempt: 7, maxAttempts: 8, nextAttemptAt: expect.any(Number), status: 500 },
        { kind: "done" },
    ]);
});

test("a free-trial retry ends immediately with trial-specific recovery instead of starting a long provider wait", async () => {
    const events = await collect(
        { ...request, trial: true },
        fakeQuery(
            {
                type: "system",
                subtype: "api_retry",
                session_id: "s",
                attempt: 1,
                max_retries: 10,
                retry_delay_ms: 1_000,
                error_status: 502,
                error: "server_error",
            },
            { type: "stream_event", session_id: "s", event: { type: "content_block_delta", delta: { type: "text_delta", text: "never" } } },
        ),
    );

    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", code: "trial-unavailable", message: expect.stringContaining("failed messages aren't counted") },
        { kind: "done" },
    ]);
});

test("a free-trial rate limit names the trial allowance and never Claude", async () => {
    const events = await collect(
        { ...request, trial: true },
        fakeQuery({
            type: "system",
            subtype: "api_retry",
            session_id: "s",
            attempt: 1,
            max_retries: 10,
            retry_delay_ms: 1_000,
            error_status: 429,
            error: "rate_limit",
        }),
    );

    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", code: "trial-exhausted", message: expect.stringContaining("Free trial used up") },
        { kind: "done" },
    ]);
    expect(events.map((event) => JSON.stringify(event)).join(` `)).not.toContain(`Claude`);
});

test("a deterministic free-trial model refusal keeps the upstream detail and suggests another model", async () => {
    const explained = `API Error: 400 This model only supports the Interactions API`;
    const events = await collect(
        { ...request, trial: true },
        fakeQuery({ type: "assistant", session_id: "s", error: "unknown", message: { content: [{ type: "text", text: explained }] } }),
    );

    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        {
            kind: "error",
            code: "trial-model-unavailable",
            message: expect.stringMatching(/Interactions API.*Choose another model/),
        },
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
 * about the 429 is about the wrong vendor: it names Anthropic, and `retry_delay_ms` is the SDK's own
 * 620ms-and-doubling backoff rather than anything the provider said. Reading that as an instant is what put
 * "Resets 5:32 PM" (the moment of the failure) under a Google weekly quota that was five days out. Three
 * things are asserted here: the delay is IGNORED (the recorded quota wins), the vendor is the one that refused,
 * and the sentence names the POOL and the fleet rather than an "account" no routed turn has. */
const retryFrame = { type: "system", subtype: "api_retry", session_id: "s", attempt: 1, max_retries: 300, error_status: 429 } as const;

test("a routed usage-limit retry names the vendor that refused and takes its reset from that vendor's quota, not the harness backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T15:32:33.000Z"));
    const reopensAt = Date.parse("2026-08-06T09:57:46.000Z") / 1000;
    try {
        const events = await collect(
            {
                ...request,
                allowance: {
                    vendor: "Google",
                    limit: async () => ({ pool: "Claude and GPT models", spent: 31, withHeadroom: 0, reopensAt }),
                },
            },
            fakeQuery({ ...retryFrame, retry_delay_ms: 620, error: "rate_limit" }),
        );
        expect(events).toEqual([
            { kind: "session", sessionId: "s" },
            {
                kind: "error",
                code: "rate_limit",
                message:
                    "Google usage limit reached: the Claude and GPT models allowance is spent on all 31 connected accounts, not a provider outage. Send again once it resets to carry on from here.",
                resetsAt: reopensAt,
            },
            { kind: "done" },
        ]);
    } finally {
        vi.useRealTimers();
    }
});

/* A REFUSAL WITH HEADROOM STILL ON FILE IS NOT A SPENT PLAN, and this is the frame that stopped claiming it was.
 *
 * CLIProxyAPI balances across every credential it holds, so one account with room means the pool is not what
 * refused the turn: every credential was merely cooling, which a transient upstream error does for a minute.
 * The old frame answered that with a weekly reset days out, sending the user away over a condition that had
 * already cleared. No reset, and a sentence that says which condition it is. */
test("a routed refusal with an account still holding headroom reads as a cooldown, not a spent allowance", async () => {
    const events = await collect(
        { ...request, allowance: { vendor: "Google", limit: async () => ({ pool: "Claude and GPT models", spent: 30, withHeadroom: 1 }) } },
        fakeQuery({ ...retryFrame, retry_delay_ms: 620, error: "rate_limit" }),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        {
            kind: "error",
            code: "rate_limit",
            message:
                "Google refused this turn, but 1 of 31 connected accounts still has headroom for Claude and GPT models, so this is not a spent allowance and no reset will fix it. Send again; if it keeps refusing, the request is being turned away rather than the quota, and another model or harness will get through.",
        },
        { kind: "done" },
    ]);
});

// Nothing on file beats a number we made up: the client renders a limit with no reset as a plain notice, which
// is honest, where `now + backoff` reads as "already reset" and invites an immediate retry into a closed window.
test("a routed usage-limit retry with no quota reading on file carries no reset at all", async () => {
    const events = await collect(
        { ...request, allowance: { vendor: "Google", limit: async () => ({ pool: "Claude and GPT models", spent: 0, withHeadroom: 0 }) } },
        fakeQuery({ ...retryFrame, retry_delay_ms: 620, error: "rate_limit" }),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", code: "rate_limit", message: expect.stringContaining("Google usage limit reached") },
        { kind: "done" },
    ]);
});

/* THE TRANSLATOR'S OWN ANSWER, on the one path that still holds it. A terminal assistant refusal carries the
 * API's body, and CLIProxyAPI's is a model_cooldown JSON naming `reset_seconds` off its own scheduler: the one
 * number that separates a credential cooling for 40 seconds from a weekly wall. It beats the recorded snapshot,
 * which is a poll up to five minutes stale and cannot tell those two apart at all. */
test("a routed refusal takes the translator's own reset_seconds over the recorded quota", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T15:32:33.000Z"));
    try {
        const events = await collect(
            {
                ...request,
                allowance: {
                    vendor: "Google",
                    limit: async () => ({ pool: "Claude and GPT models", spent: 31, withHeadroom: 0, reopensAt: 9_999_999 }),
                },
            },
            fakeQuery({
                type: "assistant",
                session_id: "s",
                parent_tool_use_id: null,
                error: "rate_limit",
                message: {
                    content: [
                        {
                            type: "text",
                            text: 'API Error: 429 {"error":{"code":"model_cooldown","message":"All credentials for model claude-opus-4-6-thinking are cooling down","reset_seconds":40}}',
                        },
                    ],
                },
            }),
        );
        expect(events).toEqual([
            { kind: "session", sessionId: "s" },
            {
                kind: "error",
                code: "rate_limit",
                message: expect.stringContaining("Google usage limit reached"),
                resetsAt: Math.ceil(Date.parse("2026-07-31T15:32:33.000Z") / 1000) + 40,
            },
            { kind: "done" },
        ]);
    } finally {
        vi.useRealTimers();
    }
});

// The CLI files a mid-session limit hit under a non-rate_limit category, with only the sentence saying what
// happened ("You've hit your session limit · resets …"). The sentence is kept: it names the reset, our canned
// line doesn't, but the code makes it the same condition as the assistant-error rate_limit above.
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
            // A pool the plan has but the provider has no reading for: dropped, not shown at 0%.
            seven_day_opus: { utilization: null, resets_at: null },
        }),
    );
    // Both pools ride out side by side, each named: this is the whole point, a 1% pool must never be able to
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
    // An empty window list would read as "measured, and you have no limits": the opposite of unknown.
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
    // absorb runs as its own follow-up turn: its frames must reach the client instead of dying at result #1.
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

/* THE TURN THAT SAID "I'LL COME BACK WITH RESULTS", and the boundary that used to kill it. A backgrounded
 * child lives inside the turn's CLI process, so ending the stream at the first result took every running
 * child with it: 14 agents dead the moment the parent finished its sentence. The stream is held open
 * instead: the child settles, the CLI injects its task notification, and the wake turn's frames arrive on
 * this same stream like a steered follow-up. */
test("a result with a backgrounded child in flight holds the stream open for the wake turn", async () => {
    resetSubagents();
    const events = await collect(
        { ...request, conversationId: "c-hold" },
        fakeQuery(
            {
                type: "system",
                subtype: "task_started",
                session_id: "s",
                task_id: "task-1",
                tool_use_id: "call-1",
                subagent_type: "Explore",
                description: "audit chapter 4",
            },
            {
                type: "system",
                subtype: "background_tasks_changed",
                session_id: "s",
                tasks: [{ task_id: "task-1", task_type: "subagent", description: "audit chapter 4" }],
            },
            { type: "result", subtype: "success", total_cost_usd: 0.1 },
            // Minutes later the child settles: its report lands, the level empties, and the CLI wakes the
            // model with the injected notification: a main-thread turn that must reach the client in full.
            {
                type: "system",
                subtype: "task_notification",
                session_id: "s",
                task_id: "task-1",
                tool_use_id: "call-1",
                status: "completed",
                summary: "found 3 gaps",
            },
            { type: "system", subtype: "background_tasks_changed", session_id: "s", tasks: [] },
            { type: "user", session_id: "s", parent_tool_use_id: null, message: { role: "user", content: "<task-notification>…" } },
            { type: "stream_event", session_id: "s", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Consolidating." } } },
            { type: "result", subtype: "success", total_cost_usd: 0.2 },
        ),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "subagent", id: "call-1", subagentKind: "subagent", agentType: "Explore", description: "audit chapter 4" },
        { kind: "usage", costUsd: 0.1 },
        { kind: "subagent_update", id: "call-1", status: "completed", summary: "found 3 gaps" },
        { kind: "delta", text: "Consolidating." },
        { kind: "usage", costUsd: 0.2 },
        { kind: "done" },
    ]);
});

/* WHERE "BACKGROUND" COMES FROM, since it does not come from the SDK. `is_backgrounded` rides a task_updated
 * patch that never arrives, so the Agent tool call itself carries the fact, and it has to reach the frame that
 * ANNOUNCES the child, because no later frame has a field for it. The block streams ahead of the task_started
 * that opens the record, which is exactly why the mark is laid before there is a record to mark. */
test("the Agent call's run_in_background reaches the frame that announces the child", async () => {
    resetSubagents();
    const events = await collect(
        { ...request, conversationId: "c-bg" },
        fakeQuery(
            {
                type: "assistant",
                session_id: "s",
                message: {
                    content: [{ type: "tool_use", id: "call-1", name: "Agent", input: { description: "audit chapter 4", run_in_background: true } }],
                },
            },
            {
                type: "system",
                subtype: "task_started",
                session_id: "s",
                task_id: "task-1",
                tool_use_id: "call-1",
                subagent_type: "Explore",
                description: "audit chapter 4",
            },
            { type: "result", subtype: "success" },
        ),
    );
    expect(events).toContainEqual({
        kind: "subagent",
        id: "call-1",
        subagentKind: "subagent",
        agentType: "Explore",
        description: "audit chapter 4",
        background: true,
    });
});

/* A DELEGATION SENT TO THE BACKGROUND, whose result says only that the command started. Settling on it marked a
 * codex run completed 0.2 seconds in and left the roster reading "done" for the 103 seconds it actually worked,
 * so the result now ends nothing: the card keeps the child, and the background task's own notification is what
 * finishes it. */
test("a backgrounded delegation is not ended by the result that says it started", async () => {
    withoutTmux();
    resetSubagents();
    const events = await collect(
        { ...request, conversationId: "c-bgdel" },
        fakeQuery(
            {
                type: "assistant",
                session_id: "s",
                message: {
                    content: [
                        { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "codex exec 'audit the gate'", run_in_background: true } },
                    ],
                },
            },
            {
                type: "user",
                session_id: "s",
                message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "Command running in background with ID: b1" }] },
            },
            { type: "result", subtype: "success" },
        ),
    );
    expect(events).toContainEqual({
        kind: "subagent",
        id: "bash-1",
        subagentKind: "codex",
        agentType: "Codex",
        description: "audit the gate",
        background: true,
    });
    // The result moved nothing. What ends the child here is the turn ending under it: the existing rule for
    // every live child, and the only honest one once the stream it would have reported on is gone.
    expect(events.filter((event) => event.kind === "subagent_update" && event.id === "bash-1")).toEqual([
        { kind: "subagent_update", id: "bash-1", status: "killed" },
    ]);
});

// The other way a hold can end: every child settled and no wake turn announced itself within the grace
// window: closing the input is what lets the stream drain, exactly like the steered settle above. The
// child's own report still made it out before the end.
test("children settled with no wake turn: the grace window closes the input so the stream drains", async () => {
    resetSubagents();
    const steering = new SteeringQueue();
    const drained: string[] = [];
    const sdkLike: QueryFn = async function* (args) {
        yield {
            type: "system",
            subtype: "task_started",
            session_id: "s",
            task_id: "task-1",
            tool_use_id: "call-1",
            subagent_type: "Explore",
            description: "audit chapter 4",
        } as SDKMessage;
        yield {
            type: "system",
            subtype: "background_tasks_changed",
            session_id: "s",
            tasks: [{ task_id: "task-1", task_type: "subagent", description: "audit chapter 4" }],
        } as unknown as SDKMessage;
        yield { type: "result", subtype: "success" } as SDKMessage;
        yield {
            type: "system",
            subtype: "task_notification",
            session_id: "s",
            task_id: "task-1",
            tool_use_id: "call-1",
            status: "completed",
            summary: "found 3 gaps",
        } as unknown as SDKMessage;
        yield { type: "system", subtype: "background_tasks_changed", session_id: "s", tasks: [] } as unknown as SDKMessage;
        // Like the real SDK, the stream now waits on the input; only the input ending lets it finish.
        for await (const message of args.prompt as AsyncIterable<SDKUserMessage>) {
            drained.push(String(message.message.content));
        }
    };
    const events = await collect({ ...request, conversationId: "c-nowake", steering }, sdkLike);
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "subagent", id: "call-1", subagentKind: "subagent", agentType: "Explore", description: "audit chapter 4" },
        { kind: "subagent_update", id: "call-1", status: "completed", summary: "found 3 gaps" },
        { kind: "done" },
    ]);
    expect(drained).toEqual(["add a /ping route"]);
    expect(steering.push("too late")).toBe(false);
});

// A backgrounded shell survives the turn on its own: it runs in the turn's tmux session, which the daemon
// owns, and holding on one would keep a turn spinning for as long as a dev server runs. Only in-process
// children move the boundary; this stream ends at its result, and the trailing frame proves it was not held.
test("a backgrounded shell does not hold the turn open", async () => {
    const events = await collect(
        request,
        fakeQuery(
            {
                type: "system",
                subtype: "background_tasks_changed",
                session_id: "s",
                tasks: [{ task_id: "task-9", task_type: "shell", description: "pnpm dev" }],
            },
            { type: "result", subtype: "success" },
            { type: "stream_event", session_id: "s", event: { type: "content_block_delta", delta: { type: "text_delta", text: "never" } } },
        ),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "done" }]);
});

/* THE SWALLOWED PROMPT. A resume that wakes to its own stale background-task notifications classifies the
 * whole run as a notification wake: the prompt is dequeued into the dying run, never answered, and the run
 * results instantly: subtype success, num_turns 0, not one frame of work. To the user that is a sent message
 * producing nothing at all. The recovery is the one they perform by hand (say it again) done here through
 * the steering queue, whose follow-up turn runs in the same process. */
test("an instant empty result redelivers the prompt instead of ending the turn on nothing", async () => {
    const drained: string[] = [];
    const swallowing: QueryFn = async function* (args) {
        const input = (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        // The prompt is dequeued into the dying run and never answered...
        drained.push(String((await input.next()).value?.message.content));
        yield { type: "result", subtype: "success", num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } } as SDKMessage;
        // ...and its redelivered copy runs as a follow-up turn in the same process.
        drained.push(String((await input.next()).value?.message.content));
        yield {
            type: "stream_event",
            session_id: "s",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Pong." } },
        } as SDKMessage;
        yield { type: "result", subtype: "success", num_turns: 1, total_cost_usd: 0.1 } as SDKMessage;
        for (let step = await input.next(); step.done !== true; step = await input.next()) {
            drained.push(String(step.value.message.content));
        }
    };
    const steering = new SteeringQueue();
    const events = await collect({ ...request, steering }, swallowing);
    // The same words, delivered twice, and the empty result never reached the client: no zero-usage frame,
    // only the follow-up turn that actually answered.
    expect(drained).toEqual(["add a /ping route", "add a /ping route"]);
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "delta", text: "Pong." },
        { kind: "usage", costUsd: 0.1, numTurns: 1 },
        { kind: "done" },
    ]);
});

test("redelivery is once per turn: a second empty answer surfaces instead of looping the prompt at it", async () => {
    const drained: string[] = [];
    const swallowingTwice: QueryFn = async function* (args) {
        const input = (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        drained.push(String((await input.next()).value?.message.content));
        yield { type: "result", subtype: "success", num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } } as SDKMessage;
        drained.push(String((await input.next()).value?.message.content));
        yield { type: "result", subtype: "success", num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } } as SDKMessage;
        for (let step = await input.next(); step.done !== true; step = await input.next()) {
            drained.push(String(step.value.message.content));
        }
    };
    const steering = new SteeringQueue();
    const events = await collect({ ...request, steering }, swallowingTwice);
    // One redelivery, not a loop, and the second empty answer is a different problem, so it is surfaced.
    expect(drained).toEqual(["add a /ping route", "add a /ping route"]);
    expect(events).toEqual([{ kind: "usage", inputTokens: 0, outputTokens: 0, numTurns: 0 }, { kind: "done" }]);
});

test("a local command's own num_turns-0 success is a real answer, not a swallowed prompt", async () => {
    const drained: string[] = [];
    const localCommand: QueryFn = async function* (args) {
        const input = (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        drained.push(String((await input.next()).value?.message.content));
        // The CLI answered the command itself: no model request ran, so the result legitimately counts no turns.
        yield {
            type: "system",
            subtype: "local_command_output",
            session_id: "s",
            content: "<local-command-stdout>Session: 12k tokens</local-command-stdout>",
        } as SDKMessage;
        yield { type: "result", subtype: "success", num_turns: 0 } as SDKMessage;
        for (let step = await input.next(); step.done !== true; step = await input.next()) {
            drained.push(String(step.value.message.content));
        }
    };
    const steering = new SteeringQueue();
    const events = await collect({ ...request, steering }, localCommand);
    expect(drained).toEqual(["add a /ping route"]);
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "delta", text: "Session: 12k tokens" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
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

test("a thrown error from a free-trial SDK turn uses the refundable trial failure", async () => {
    expect(await collect({ ...request, trial: true }, throwing)).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", code: "trial-unavailable", message: expect.stringContaining("failed messages aren't counted") },
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
 * Dropping this message (which the translation did) made every such command look broken: the turn ended with
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
 * the leading `/`, found no such command, and discarded the rest. Coded, not narrated: the client holds the
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

/* THE FAST-MODE OPT-IN. Fast mode is off for an SDK consumer until it asks: the harness's own word for that
 * state is `sdk_opt_in_required`, so a turn that wants it has to say so in the inline settings object, and a
 * turn that doesn't must say NOTHING rather than `false`: the flag layer sits above the user's own
 * settings.json, so writing false there would override an opt-in the owner made for themselves on turns this
 * composer never expressed an opinion about.
 *
 * `fastModePerSessionOptIn` is the half that keeps the bill honest. Without it the harness persists the choice
 * to the settings file, which in this container is shared by every conversation, every automation and every
 * front desk turn, so one chat's toggle would quietly move all of them onto fast-mode pricing. */
test("fast speed is asked for per session, and only by the turn that wanted it", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect({ ...request, fast: true }, capture);
    expect(captured.at(-1)?.settings).toEqual({ fastMode: true, fastModePerSessionOptIn: true });

    // Not `{fastMode: false}`, an absent ask must leave the lower-precedence settings layers alone.
    await collect(request, capture);
    expect(captured.at(-1)?.settings).toBeUndefined();
});

/* WHAT SPEED THE TURN ACTUALLY RAN AT, which is the half that makes the toggle above safe to ship. Fast mode
 * declines silently and for a lot of reasons the composer cannot see (the plan, the model, the pool, the
 * endpoint), so asking for it and not getting it is otherwise indistinguishable from getting it: same frames,
 * same text, a bill that differs by 2x. */
test("the speed the harness served is reported once, and again only when it changes", async () => {
    withoutTmux();
    const events = await collect(
        request,
        fakeQuery(
            { type: "system", subtype: "init", session_id: "s", model: "opus", fast_mode_state: "on" },
            // The settled result agrees with init: no second frame, because a notice that repeats itself is
            // one the user learns to stop reading.
            { type: "result", subtype: "success", result: "ok", fast_mode_state: "on" },
        ),
    );

    expect(events.filter((event) => event.kind === "fast_mode")).toEqual([{ kind: "fast_mode", state: "on" }]);
});

test("a turn that drops into cooldown mid-flight says so", async () => {
    withoutTmux();
    const events = await collect(
        request,
        fakeQuery(
            { type: "system", subtype: "init", session_id: "s", model: "opus", fast_mode_state: "on" },
            // Fast mode draws on its own rate-limit pool; exhausting it finishes the turn at standard speed.
            { type: "result", subtype: "success", result: "ok", fast_mode_state: "cooldown" },
        ),
    );

    expect(events.filter((event) => event.kind === "fast_mode")).toEqual([
        { kind: "fast_mode", state: "on" },
        { kind: "fast_mode", state: "cooldown" },
    ]);
});

/* The reason moves on its own, and the move is the informative half: `init` can answer "off, still checking"
 * and the result then names the actual blocker. De-duplicating on the STATE alone would swallow that second
 * frame and leave the user with a permanent "confirming…" for a turn that had long since been refused. */
test("a reason that arrives after the state is still reported", async () => {
    withoutTmux();
    const events = await collect(
        request,
        fakeQuery(
            { type: "system", subtype: "init", session_id: "s", model: "opus", fast_mode_state: "off", fast_mode_disabled_reason: "pending" },
            { type: "result", subtype: "success", result: "ok", fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" },
        ),
    );

    expect(events.filter((event) => event.kind === "fast_mode")).toEqual([
        { kind: "fast_mode", state: "off", reason: "pending" },
        { kind: "fast_mode", state: "off", reason: "extra_usage_disabled" },
    ]);
});

// A harness that reports nothing about speed yields no frame at all: an absent answer is not "off", and
// rendering one would put a notice under every turn on every runtime that never had fast mode to begin with.
test("a harness that says nothing about speed produces no frame", async () => {
    withoutTmux();
    const events = await collect(
        request,
        fakeQuery({ type: "system", subtype: "init", session_id: "s", model: "opus" }, { type: "result", subtype: "success", result: "ok" }),
    );

    expect(events.some((event) => event.kind === "fast_mode")).toBe(false);
});
