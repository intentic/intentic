import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { Options, PermissionResult, PermissionUpdate, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import type { AgentEvent, AgentReply } from "@intentic/sandbox-contract";
import { afterEach, expect, test, vi } from "vitest";
import { mergeHooks, type OauthRecoveryOptions, runAgent } from "./agent.js";
import type { AgentQuery, QueryFn } from "./sdk-stream.js";
import { resolveRequest } from "../tools/agent-requests.js";
import { SteeringQueue } from "../anchors/agent-steering.js";
import { noteSubagentTask, resetSubagents } from "../subagents/subagents.js";
import { EDIT_TOOLS } from "../../rules/edit-tools.js";

// Fake QueryFn yielding canned SDK messages; runAgent reads only the fields exercised here.
const fakeQuery = (...messages: unknown[]): QueryFn =>
    async function* () {
        for (const message of messages) {
            yield message as SDKMessage;
        }
    };

const proseBlock = (text: string, sessionId?: string): SDKMessage[] => [
    {
        type: "stream_event",
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
    } as SDKMessage,
    {
        type: "stream_event",
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    } as SDKMessage,
    {
        type: "stream_event",
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
        event: { type: "content_block_stop", index: 0 },
    } as SDKMessage,
];

const collect = async (request: Parameters<typeof runAgent>[0], queryFn: QueryFn, usageFetch?: typeof fetch): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of runAgent(request, queryFn, usageFetch)) {
        events.push(event);
    }
    return events;
};

// browserOutputDir present is a browser-carrying turn; its absence is the core-image signal that strips browser
// guidance.
const request = {
    prompt: "add a /ping route",
    cwd: WORKSPACE_ROOT,
    signal: new AbortController().signal,
    browserOutputDir: `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser`,
};

// Forces the pre-tmux event shape: bash routing depends on whether the image bakes in the tmux wrapper
// (agent-terminal-frame.test.ts covers the enabled path).
const withoutTmux = (): void => {
    vi.stubEnv("INTENTIC_AGENT_TMUX", "0");
};

/* THE GRACE WINDOW, WITHOUT THE WAIT. A steered stream ends on a second of silence after its last result
 * (sdk-stream.ts STEER_GRACE_MS), and four cases below reach that ending. Waited out in real time they were the
 * four slowest tests in this file, a second each, and what the second measured was the constant rather than the
 * ordering. So the work runs under a fake setTimeout and the clock is walked forward a window per pass until the
 * work settles: the same sequence of events, none of the waiting. Only setTimeout is faked, so Date and
 * everything else on the loop stay real. */
const withoutTheGraceWait = async <T>(work: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
        let settled = false;
        const pending = work().finally(() => {
            settled = true;
        });
        for (;;) {
            if (settled) {
                return await pending;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- the loop IS the clock: one window per pass
            await vi.advanceTimersByTimeAsync(1_000);
        }
    } finally {
        vi.useRealTimers();
    }
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
            // Only a text block's content_block_stop closes a prose bubble, not a tool_use block's.
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
    // Parent and subagent streams both index blocks from 0; the boundary is keyed per agent so a shared index can't
    // retire the wrong one.
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

// Compares against the ambient env, not undefined: a turn's env spreads `{...process.env, …}`.
const ambient = (name: string): string | undefined => process.env[name];

test("the delegation ceilings reach the CLI only where the turn names one", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect(request, capture);
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"]).toBe(ambient("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"));
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"]).toBe(ambient("CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"));
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"]).toBe(ambient("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"));

    // Each ceiling is independent: raising one must not add env vars for the other two.
    await collect({ ...request, subagentsAtOnce: 50 }, capture);
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"]).toBe("50");
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"]).toBe(ambient("CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"));
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"]).toBe(ambient("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"));

    await collect({ ...request, subagentsAtOnce: 40, subagentsPerTurn: 500, subagentDepth: 5 }, capture);
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"]).toBe("40");
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"]).toBe("500");
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"]).toBe("5");
});

// Claude Code hides the Task* tools unless CLAUDE_CODE_ENABLE_TASKS is set, while CHECKLIST_GUIDANCE still tells the
// model to look for them; both halves are asserted together.
test("every turn pins the checklist tools on, and says so in the prompt it pins them for", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect(request, capture);
    // Set unconditionally: the model-version gate behind this can move without warning.
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_ENABLE_TODO_TOOLS"]).toBe("1");
    // Enables the Task* half of the tool family, the one the prompt names and task-checklist.ts parses.
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_ENABLE_TASKS"]).toBe("1");
    expect(captured.at(-1)?.systemPrompt as string).toContain("select:TaskCreate,TaskUpdate,TaskList");
});

// The env token is a snapshot at spawn; getOAuthToken lets the SDK request a fresh one if the turn outlives it or the
// account is revoked mid-turn.
test("a native Claude turn hands the SDK a way to re-mint its token mid-turn", async () => {
    const captured: OauthRecoveryOptions[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    const refreshOauthToken = async (): Promise<string> => "tok-2";
    await collect({ ...request, oauthToken: "tok-1", refreshOauthToken }, capture);
    expect(await captured.at(-1)?.getOAuthToken?.({ signal: new AbortController().signal })).toBe("tok-2");

    // A routed turn and the container-env fallback have no refresh token to re-mint, so neither gets a getOAuthToken
    // callback.
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

    // baseUrl always wins over oauthToken: the Anthropic subscription token must never reach a foreign endpoint.
    await collect({ ...request, baseUrl: "http://127.0.0.1:8788", authToken: "router-key", oauthToken: "tok-xyz", model: "gpt-5-codex" }, capture);
    expect(captured.at(-1)?.env?.["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:8788");
    expect(captured.at(-1)?.env?.["ANTHROPIC_AUTH_TOKEN"]).toBe("router-key");
    expect(captured.at(-1)?.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    expect(captured.at(-1)?.model).toBe("gpt-5-codex");
});

// Prompt composition rules live in system-prompt.test.ts; this only checks that runAgent forwards both prompt shapes
// into the SDK options.
test("a request with no mode runs Intentic's prompt, and each mode reaches the SDK in its own shape", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    // An absent mode is the product default: a request built by hand must get the same agent the app ships.
    await collect(request, capture);
    const intentic = captured.at(-1)?.systemPrompt as string;
    expect(intentic).toMatch(/Intentic agent/i);
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

    // A custom prompt replaces the harness prompt entirely (sent as a bare string), not merely prefixes it.
    await collect({ ...request, systemPromptMode: "custom", systemPrompt: "You are a release-notes writer." }, capture);
    expect(captured.at(-1)?.systemPrompt).toBe("You are a release-notes writer.");
});

// Two producers register PreToolUse:Bash; a plain object spread would let the second overwrite the first. Needs
// /usr/local/bin/tmux-run (image-only, not on a host).
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
    expect(captured.at(-1)?.hooks?.PostToolUse?.some((matcher) => matcher.matcher === EDIT_TOOLS)).toBe(true);
});

test("every turn wires the ui ask server, the AskUserQuestion alias, and the permission gate", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect(request, capture);
    expect(Object.keys(captured.at(-1)?.mcpServers ?? {})).toContain("ui");
    // Two aliases: the ask card's AskUserQuestion and the JS execution backend's Code (execution/js-tool.ts).
    expect(captured.at(-1)?.toolAliases).toEqual({ AskUserQuestion: "mcp__ui__ask", Code: "mcp__code__run" });
    expect(captured.at(-1)?.canUseTool).toBeTypeOf("function");
    expect(captured.at(-1)?.permissionMode).toBe("bypassPermissions");
    expect(captured.at(-1)?.allowDangerouslySkipPermissions).toBe(true);
});

// The code server mounts only when the request carries a jsExecution field; no plan means no server.
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
    expect(Object.keys(captured.at(-1)?.mcpServers ?? {})).toContain("code");
});

test("the request's tools become remote http MCP servers alongside the ui server, in every mode", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };
    const obs = { type: "http", url: "https://signoz.example.com/mcp", headers: { Authorization: "Bearer tok" } };
    const tools = [{ name: "obs", url: "https://signoz.example.com/mcp", token: "tok" }];

    await collect({ ...request, tools }, capture);
    expect(captured.at(-1)?.mcpServers?.["obs"]).toEqual(obs);
    expect(Object.keys(captured.at(-1)?.mcpServers ?? {})).toContain("ui");

    await collect({ ...request, permissionMode: "plan" as const, tools }, capture);
    expect(captured.at(-1)?.mcpServers?.["obs"]).toEqual(obs);
    expect(Object.keys(captured.at(-1)?.mcpServers ?? {})).toContain("ui");
    expect(captured.at(-1)?.permissionMode).toBe("plan");
    // Set on every launch, not only bypassPermissions turns: a plan approval later sets mode to bypassPermissions,
    // which the CLI refuses without this flag at launch.
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

// Drives the permission gate end-to-end: canUseTool is called mid-stream and answered as the browser would
// (resolveRequest), returning the gate's decision.
type DecidableCard = Extract<AgentEvent, { kind: "permission" | "plan" }>;

const decide = async (
    turn: Parameters<typeof runAgent>[0],
    call: { tool: string; input?: Record<string, unknown>; suggestions?: PermissionUpdate[]; prose?: string },
    answer: (event: DecidableCard) => AgentReply,
): Promise<{ result: PermissionResult; card: DecidableCard; frames: AgentEvent[] }> => {
    let result: PermissionResult | null | undefined;
    let card: DecidableCard | undefined;
    const frames: AgentEvent[] = [];
    const query: QueryFn = async function* (args) {
        const gate = args.options.canUseTool!;
        if (call.prose !== undefined) {
            yield* proseBlock(call.prose);
        }
        // Yielded before the gate call, matching real SDK order (message enqueued before canUseTool dispatches).
        yield {
            type: "assistant",
            message: { content: [{ type: "tool_use", id: `call-${call.tool}`, name: call.tool, input: call.input ?? {} }] },
        } as SDKMessage;
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
    // The SDK's suggestion is command-scoped; 'always' additionally adds a tool-wide allow rule so the next command
    // doesn't re-ask.
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
    // The frame log is what a reload replays; a decided card missing from it comes back live, with buttons on a
    // requestId the daemon no longer holds.
    const { card, frames } = await decide({ ...request, permissionMode: "default" }, { tool: "WebFetch" }, (event) => ({
        kind: "permission",
        requestId: event.requestId,
        decision: "once",
    }));

    expect(frames.filter((frame) => frame.kind === "resolved")).toEqual([
        { kind: "resolved", requestId: card.requestId, reply: { kind: "permission", requestId: card.requestId, decision: "once" } },
    ]);
    // The resolved frame lands after the card it settles, so replay never shows it before the card exists.
    expect(frames.findIndex((frame) => frame.kind === "resolved")).toBeGreaterThan(frames.findIndex((frame) => frame.kind === "permission"));
});

test("an approved plan executes with permissions bypassed, whatever the turn planned from", async () => {
    const approve = (event: DecidableCard): AgentReply => ({ kind: "plan", requestId: event.requestId, approve: true });

    // Approving a plan always executes with permissions bypassed, whatever mode the turn planned from; the container is
    // the isolation boundary either way.
    for (const permissionMode of ["plan", "default", "acceptEdits", "bypassPermissions"] as const) {
        const { result, frames } = await decide({ ...request, permissionMode }, { tool: "ExitPlanMode", prose: "# Plan" }, approve);
        expect(result).toMatchObject({ updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] });
        // The mode frame tells the composer's pill the turn is no longer planning.
        expect(frames).toContainEqual({ kind: "mode", mode: "bypassPermissions" });
    }
});

test("ExitPlanMode uses the adjacent prose as its plan because the current SDK call has no plan input", async () => {
    const plan = "# Make rollback quiet\n\n- Collapse the recovery controls.\n- Keep updates prominent.";
    const { card } = await decide({ ...request, permissionMode: "plan" }, { tool: "ExitPlanMode", prose: plan }, (event) => ({
        kind: "plan",
        requestId: event.requestId,
        approve: true,
    }));

    expect(card).toMatchObject({ kind: "plan", text: plan });
});

test("ExitPlanMode refuses to raise an empty approval card", async () => {
    // `null` matches the SDK's own canUseTool return type, as widened by the `decide` helper above.
    let result: PermissionResult | null | undefined;
    const frames = await collect({ ...request, permissionMode: "plan" }, async function* (args) {
        result = await args.options.canUseTool!("ExitPlanMode", {}, { signal: request.signal } as never);
        yield { type: "result", subtype: "success" } as SDKMessage;
    });

    expect(result).toEqual({
        behavior: "deny",
        message: "Write the complete plan in your response, then call ExitPlanMode again.",
    });
    expect(frames.some((frame) => frame.kind === "plan")).toBe(false);
});

// Plan approval rebases onto today's main line before the agent builds; these tests own WHEN the rebase fires.
// Shape of what resync returns: only the summary line is exposed to the reader.
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
        { tool: "ExitPlanMode", prose: "# Plan" },
        (event) => ({ kind: "plan", requestId: event.requestId, approve: true }),
    );

    expect(calls).toBe(1);
    // The worktree frame lands after the card it settles, not at the top of the turn.
    expect(frames.filter((frame) => frame.kind === "worktree")).toEqual([parkedSync]);
    expect(frames.findIndex((frame) => frame.kind === "worktree")).toBeGreaterThan(frames.findIndex((frame) => frame.kind === "resolved"));
    // No preamble frame: the model was given no words about the rebase to relay.
    expect(frames.some((frame) => frame.kind === "preamble")).toBe(false);
    // The steering queue, the only channel back to the model here, stays empty.
    expect(steering.delivered).toBe(0);
});

// A rejected plan must not rebase: that would move work the user just declined.
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
        { tool: "ExitPlanMode", prose: "# Plan" },
        (event) => ({ kind: "plan", requestId: event.requestId, approve: false, feedback: "not yet" }),
    );

    expect(calls).toBe(0);
});

// A branch already current gets no worktree frame and no steering message.
test("an approved plan on a current branch says nothing", async () => {
    withoutTmux();
    const steering = new SteeringQueue();
    const { frames } = await decide({ ...request, steering, resync: async () => undefined }, { tool: "ExitPlanMode", prose: "# Plan" }, (event) => ({
        kind: "plan",
        requestId: event.requestId,
        approve: true,
    }));

    expect(frames.some((frame) => frame.kind === "worktree")).toBe(false);
    expect(steering.delivered).toBe(0);
});

// A running subagent edits files on its own; rebasing under it can swap files mid-read or sweep a half-written file
// into the commit, so the rebase waits until it settles.
test("a subagent still running holds the rebase off", async () => {
    withoutTmux();
    resetSubagents();
    const conversationId = "c-parked";
    let calls = 0;
    noteSubagentTask(
        { conversationId, cwd: WORKSPACE_ROOT, sessionId: undefined, subagentsDir: undefined },
        { subtype: "task_started", task_id: "task-park", tool_use_id: "agent-1", description: "port the tests", subagent_type: "general-purpose" },
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
        { tool: "ExitPlanMode", prose: "# Plan" },
        (event) => ({ kind: "plan", requestId: event.requestId, approve: true }),
    );

    expect(calls).toBe(0);
    // Once the subagent settles, the same approval takes the rebase it skipped before.
    noteSubagentTask(
        { conversationId, cwd: WORKSPACE_ROOT, sessionId: undefined, subagentsDir: undefined },
        { subtype: "task_updated", task_id: "task-park", patch: { status: "completed" } },
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
        { tool: "ExitPlanMode", prose: "# Plan" },
        (event) => ({ kind: "plan", requestId: event.requestId, approve: true }),
    );
    expect(calls).toBe(1);
});

// A plan approval must succeed even when resync throws: a git failure must not turn the user's answer into a failure or
// an unrebased branch reported as approved.
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
        { tool: "ExitPlanMode", prose: "# Plan" },
        (event) => ({ kind: "plan", requestId: event.requestId, approve: true }),
    );

    expect(result).toMatchObject({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "bypassPermissions" }] });
});

// A permission answer never resyncs: the tool call was computed against the tree as it was; moving files under an
// approved Edit would break it.
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

// Hitting the iteration cap is coded as 'turn-cap', distinct from an unclassified failure downstream can't handle.
test("a turn that hits the iteration cap becomes a coded error followed by done", async () => {
    const events = await collect(request, fakeQuery({ type: "result", subtype: "error_max_turns", session_id: "s" }));
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", code: "turn-cap", message: "agent did not complete (error_max_turns)" },
        { kind: "done" },
    ]);
});

test("any other non-success result is the harness failing, and says so", async () => {
    const events = await collect(request, fakeQuery({ type: "result", subtype: "error_during_execution", session_id: "s" }));
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", code: "harness-incomplete", message: "agent did not complete (error_during_execution)" },
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
            message: "Claude usage limit reached. Send again once it resets.",
        },
        { kind: "done" },
    ]);
});

test("a non-rate-limit assistant error with no explanation falls back to its bare category", async () => {
    const events = await collect(request, fakeQuery({ type: "assistant", session_id: "s", error: "unknown", message: { content: [] } }));
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", message: "agent error: unknown" }, { kind: "done" }]);
});

// An org-disabled Claude Code seat is coded claude-not-entitled, not claude-token-refused: no re-minted token restores
// a revoked seat.
test("a revoked Claude Code seat is coded as its own refusal, not as a credential to re-mint", async () => {
    const seat =
        "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "unknown", message: { content: [{ type: "text", text: seat }] } }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", code: "claude-not-entitled", message: seat }, { kind: "done" }]);
});

// A routed provider's spent-plan 403 matches the CLI's own auth-failure prefix; coded rate_limit rather than a
// credential to reconnect, keeping the provider's sentence.
test("a routed provider's spent plan is coded as a limit, not as a credential to reconnect", async () => {
    const kimi =
        "Failed to authenticate. API Error: 403 You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "unknown", message: { content: [{ type: "text", text: kimi }] } }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", code: "rate_limit", message: kimi }, { kind: "done" }]);
});

// A genuinely revoked token still needs re-minting, not a rate-limit reset that will never arrive.
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

// 5xx/socket failures (server_error) and pre-retry capacity refusals (overloaded) are both coded provider-outage,
// classified by category rather than wording that changes across CLI releases.
test("a server_error is coded as a provider outage, keeping the provider's own sentence", async () => {
    const outage = "API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "server_error", message: { content: [{ type: "text", text: outage }] } }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", code: "provider-outage", message: outage }, { kind: "done" }]);
});

// The only 4xx coded as an outage: it names a parameter this client never sends, so retrying is safe, unlike other 4xx
// which would loop.
test("a refused parameter nothing here sends is coded as an outage, though it arrives as a 400", async () => {
    const refusal =
        'API Error: 400 {"error":{"type":"invalid_request_error","code":"invalid_parameter","message":"prompt_cache_retention is not supported on this model","param":"prompt_cache_retention"}}';
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "unknown", message: { content: [{ type: "text", text: refusal }] } }),
    );
    const failure = events.find((event) => event.kind === "error") as { code?: string; message: string } | undefined;
    expect(failure?.code).toBe("provider-outage");
    // The provider's sentence is kept verbatim; only the fact the reader can't check is added.
    expect(failure?.message).toMatch(/prompt_cache_retention.*not supported/i);
});

test("a 529 at capacity is the same condition as a 500: one code covers both", async () => {
    const overloaded = "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "overloaded", message: { content: [{ type: "text", text: overloaded }] } }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", code: "provider-outage", message: overloaded }, { kind: "done" }]);
});

// An in-turn retry is a live turn, not a hang: surfaced as a waiting status so the user doesn't Stop it and lose the
// work mid-retry.
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
        // 300 is the harness's retry budget; the daemon honours only 8, and the wire reports the honoured number.
        { kind: "provider_retry", attempt: 3, maxAttempts: 8, nextAttemptAt: expect.any(Number), status: 529 },
        { kind: "done" },
    ]);
});

// A transport failure has no HTTP status; the frame omits it rather than inventing one the client would render as if
// the provider had answered.
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

// Past the in-turn retry bound the turn ends as an outage instead of spinning through all 300 harness retries; the
// breaker and resume scheduler take over from there.
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
            // Never reached: the stream ends here, so the CLI isn't left retrying behind a card that already settled.
            { type: "stream_event", session_id: "s", event: { type: "content_block_delta", delta: { type: "text_delta", text: "never" } } },
        ),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", code: "provider-outage", message: expect.stringMatching(/8.*500|500.*8/) },
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
        { kind: "error", code: "trial-unavailable", message: expect.stringMatching(/failed messages|not counted|Free trial unavailable/i) },
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
        { kind: "error", code: "trial-exhausted", message: expect.stringMatching(/trial.*used|Free trial used up/i) },
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
                // Returning on the retry closes the SDK iterator so the exhausted turn stops instead of spinning.
                { type: "stream_event", session_id: "s", event: { type: "content_block_delta", delta: { type: "text_delta", text: "never" } } },
            ),
        );
        expect(events).toEqual([
            { kind: "session", sessionId: "s" },
            {
                kind: "error",
                code: "rate_limit",
                message: expect.stringMatching(/usage limit/i),
                resetsAt: Date.parse("2026-07-30T20:15:00.000Z") / 1000,
            },
            { kind: "done" },
        ]);
    } finally {
        vi.useRealTimers();
    }
});

// Routed 429s must use the recorded vendor quota's reset, not the SDK's own backoff delay.
const retryFrame = { type: "system", subtype: "api_retry", session_id: "s", attempt: 1, max_retries: 300, error_status: 429 } as const;

test("a routed usage-limit retry names the vendor that refused and takes its reset from that vendor's quota, not the harness backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T15:32:33.000Z"));
    const reopensAt = Date.parse("2026-08-06T09:57:46.000Z") / 1000;
    try {
        const vendor = "Google";
        const pool = "Claude and GPT models";
        const spent = 31;
        const events = await collect(
            {
                ...request,
                allowance: {
                    vendor,
                    limit: async () => ({ pool, spent, withHeadroom: 0, reopensAt }),
                },
            },
            fakeQuery({ ...retryFrame, retry_delay_ms: 620, error: "rate_limit" }),
        );
        const failure = events.find((event) => event.kind === "error") as { message: string; resetsAt: number } | undefined;
        expect(failure?.message).toContain(vendor);
        expect(failure?.message).toContain(pool);
        expect(failure?.message).toContain(String(spent));
        expect(failure?.resetsAt).toBe(reopensAt);
        expect(events.at(-1)).toEqual({ kind: "done" });
    } finally {
        vi.useRealTimers();
    }
});

// A refusal with headroom still on an account is a cooldown, not a spent pool: CLIProxyAPI balances across credentials,
// so one cooling account isn't exhaustion.
test("a routed refusal with an account still holding headroom reads as a cooldown, not a spent allowance", async () => {
    const vendor = "Google";
    const pool = "Claude and GPT models";
    const spent = 30;
    const headroom = 1;
    const events = await collect(
        { ...request, allowance: { vendor, limit: async () => ({ pool, spent, withHeadroom: headroom }) } },
        fakeQuery({ ...retryFrame, retry_delay_ms: 620, error: "rate_limit" }),
    );
    const failure = events.find((event) => event.kind === "error") as { message: string; code: string } | undefined;
    expect(failure?.code).toBe("rate_limit");
    expect(failure?.message).toContain(vendor);
    expect(failure?.message).toContain(pool);
    expect(failure?.message).toContain(String(headroom));
    expect(failure?.message).toMatch(/headroom|cooling/i);
    expect(events.at(-1)).toEqual({ kind: "done" });
});

// With no quota reading on file, no reset time is invented; `now + backoff` would read as already-reset and invite a
// retry into a still-closed window.
test("a routed usage-limit retry with no quota reading on file carries no reset at all", async () => {
    const events = await collect(
        { ...request, allowance: { vendor: "Google", limit: async () => ({ pool: "Claude and GPT models", spent: 0, withHeadroom: 0 }) } },
        fakeQuery({ ...retryFrame, retry_delay_ms: 620, error: "rate_limit" }),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", code: "rate_limit", message: expect.stringMatching(/Google.*usage limit/i) },
        { kind: "done" },
    ]);
});

// A translator's own model_cooldown reset_seconds (from its scheduler) overrides the recorded quota snapshot, which can
// be stale.
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

// A mid-session limit can arrive under a non-rate_limit category with only its sentence saying so; coded rate_limit but
// keeping that sentence, since it names the reset ours doesn't.
test("a usage-limit sentence under another error category is classified as rate_limit, keeping its own text", async () => {
    const limitText = "You've hit your session limit · resets 1:40pm (UTC)";
    const events = await collect(
        request,
        fakeQuery({ type: "assistant", session_id: "s", error: "unknown", message: { content: [{ type: "text", text: limitText }] } }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "error", code: "rate_limit", message: limitText }, { kind: "done" }]);
});

// 'unknown' is the SDK's catch-all for every 4xx; the API's own sentence in the text block is the only useful part of
// the frame.
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

// The turn ran on a stored account's OAuth token, so plan limits are readable at settle.
const oauthRequest = { ...request, oauthToken: "oat-1" };
// Fakes the OAuth usage endpoint; the daemon reads it directly since the CLI reports rate limits only for a profile it
// signed in itself.
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
    // Pools are reported separately so a 1% pool never stands in for a 98% one; resets convert to epoch seconds.
    expect(events).toEqual([
        {
            kind: "account_usage",
            windows: [
                { kind: "five_hour", utilization: 12.4, resetsAt: Date.parse("2026-07-27T18:00:00.000Z") / 1000, gates: "all" },
                { kind: "seven_day", utilization: 98, resetsAt: Date.parse("2026-07-29T09:00:00.000Z") / 1000, gates: "all" },
            ],
        },
        { kind: "done" },
    ]);
});

test("a turn with no plan limits to read yields no account_usage frame at all", async () => {
    // An empty list would misread as 'no limits'; here the endpoint refuses the credential (no plan).
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
    // The SDK emits one result per turn on streaming input; a steered message the running turn can't absorb runs its
    // own follow-up turn, whose frames must still reach the client.
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
    // Like the real SDK, the stream stays open after its result until the grace window closes the input queue.
    const sdkLike: QueryFn = async function* (args) {
        yield { type: "result", subtype: "success" } as SDKMessage;
        for await (const message of args.prompt as AsyncIterable<SDKUserMessage>) {
            drained.push(String(message.message.content));
        }
    };
    const events = await withoutTheGraceWait(() => collect({ ...request, steering }, sdkLike));
    expect(events).toEqual([{ kind: "done" }]);
    expect(drained).toEqual(["add a /ping route", "absorbed mid-turn"]);
    expect(steering.push("too late")).toBe(false);
});

// A backgrounded child (task_type local_agent) keeps the stream open past the parent's first result until its wake
// turn's frames arrive, instead of ending the stream and killing the child.
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
                tasks: [{ task_id: "task-1", task_type: "local_agent", description: "audit chapter 4" }],
            },
            { type: "result", subtype: "success", total_cost_usd: 0.1 },
            // When the child settles, the CLI wakes the model with an injected notification; that follow-up turn must
            // reach the client in full.
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

// is_backgrounded never arrives as a task_updated patch, so the Agent call's own run_in_background field must reach the
// frame that announces the child.
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

// If every child settles with no wake turn inside the grace window, closing the input drains the stream, as with a
// steered settle; the child's report still arrives first.
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
            tasks: [{ task_id: "task-1", task_type: "local_agent", description: "audit chapter 4" }],
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
    const events = await withoutTheGraceWait(() => collect({ ...request, conversationId: "c-nowake", steering }, sdkLike));
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "subagent", id: "call-1", subagentKind: "subagent", agentType: "Explore", description: "audit chapter 4" },
        { kind: "subagent_update", id: "call-1", status: "completed", summary: "found 3 gaps" },
        { kind: "done" },
    ]);
    expect(drained).toEqual(["add a /ping route"]);
    expect(steering.push("too late")).toBe(false);
});

// A backgrounded shell runs in the daemon's own tmux session and outlives the turn on its own; only in-process children
// (agents) hold the stream open.
test("a backgrounded shell does not hold the turn open", async () => {
    const events = await collect(
        request,
        fakeQuery(
            {
                type: "system",
                subtype: "background_tasks_changed",
                session_id: "s",
                tasks: [{ task_id: "task-9", task_type: "local_bash", description: "pnpm dev" }],
            },
            { type: "result", subtype: "success" },
            { type: "stream_event", session_id: "s", event: { type: "content_block_delta", delta: { type: "text_delta", text: "never" } } },
        ),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "done" }]);
});

// An unrecognised background task type holds the stream open by default (the allow-list names only what may be
// abandoned), so a new SDK task kind fails safe.
test("an unrecognised background task type holds the turn open rather than being abandoned", async () => {
    const events = await collect(
        request,
        fakeQuery(
            {
                type: "system",
                subtype: "background_tasks_changed",
                session_id: "s",
                tasks: [{ task_id: "task-7", task_type: "local_something_new", description: "whatever ships next" }],
            },
            { type: "result", subtype: "success" },
            { type: "stream_event", session_id: "s", event: { type: "content_block_delta", delta: { type: "text_delta", text: "still here" } } },
        ),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "s" }, { kind: "delta", text: "still here" }, { kind: "done" }]);
});

// A resume that wakes to its own stale background-task notification can dequeue the prompt into a run that ends
// instantly (num_turns 0) unanswered; it is redelivered via the steering queue in the same process.
test("an instant empty result redelivers the prompt instead of ending the turn on nothing", async () => {
    const drained: string[] = [];
    const swallowing: QueryFn = async function* (args) {
        const input = (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        // Dequeued into the dying run and left unanswered.
        drained.push(String((await input.next()).value?.message.content));
        yield { type: "result", subtype: "success", num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } } as SDKMessage;
        // Its redelivered copy runs as a follow-up turn in the same process.
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
    const events = await withoutTheGraceWait(() => collect({ ...request, steering }, swallowing));
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
    const events = await withoutTheGraceWait(() => collect({ ...request, steering }, swallowingTwice));
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
        { kind: "error", code: "trial-unavailable", message: expect.stringMatching(/failed messages|not counted|Free trial unavailable/i) },
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

// A CLI-answered command bypasses the model entirely; its local_command_output message is the only thing on the stream
// carrying what it said.
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

// An unknown command discards the message after claiming the leading '/'; coded as an error rather than left silent, so
// the client can tell the user to retype.
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
    // No assistant bubble for it: 'Unknown command' is not something the agent said.
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

// Fast mode needs an explicit ask, never `false` (which would override the user's own settings.json);
// fastModePerSessionOptIn keeps a turn's opt-in from persisting to the shared settings file.
test("fast speed is asked for per session, and only by the turn that wanted it", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect({ ...request, fast: true }, capture);
    expect(captured.at(-1)?.settings).toMatchObject({ fastMode: true, fastModePerSessionOptIn: true });

    // Not `{fastMode: false}`: an absent ask must leave the lower-precedence settings layers alone.
    await collect(request, capture);
    expect(captured.at(-1)?.settings).not.toHaveProperty("fastMode");
    expect(captured.at(-1)?.settings).not.toHaveProperty("fastModePerSessionOptIn");
});

// loop, schedule, keybindings-help and update-config assume an interactive process this harness doesn't run, so they're
// hidden every turn and merged with, not replaced by, the fast-mode settings.
test("the bundled CLI-only skills are hidden from the model on every turn, fast or not", async () => {
    const captured: Options[] = [];
    const capture: QueryFn = async function* (args) {
        captured.push(args.options);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };
    const hidden = { loop: "off", schedule: "off", "keybindings-help": "off", "update-config": "off" };

    await collect(request, capture);
    expect(captured.at(-1)?.settings).toEqual({ skillOverrides: hidden });

    await collect({ ...request, fast: true }, capture);
    expect(captured.at(-1)?.settings).toEqual({ skillOverrides: hidden, fastMode: true, fastModePerSessionOptIn: true });
});

// Fast mode can decline silently for reasons the composer can't see (plan, model, pool, endpoint); without this frame,
// asking and not getting it looks identical to getting it despite a different bill.
test("the speed the harness served is reported once, and again only when it changes", async () => {
    withoutTmux();
    const events = await collect(
        request,
        fakeQuery(
            { type: "system", subtype: "init", session_id: "s", model: "opus", fast_mode_state: "on" },
            // No second frame when the result agrees with init; a repeated notice trains the user to ignore it.
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

// The reason can change independently of state (init: 'still checking', result: the actual blocker); de-duplicating on
// state alone would swallow that update.
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

// No speed frame at all when the harness says nothing about it; absent isn't 'off', and rendering one would notice-spam
// runtimes without fast mode.
test("a harness that says nothing about speed produces no frame", async () => {
    withoutTmux();
    const events = await collect(
        request,
        fakeQuery({ type: "system", subtype: "init", session_id: "s", model: "opus" }, { type: "result", subtype: "success", result: "ok" }),
    );

    expect(events.some((event) => event.kind === "fast_mode")).toBe(false);
});

// A question or plan card can carry a document the turn already wrote, attached by the daemon rather than described by
// the model.

// Reaches the `ask` tool through the SDK server's own tool registry (`_registeredTools`, private hence the cast), the
// same path the CLI uses.
const askTool = (options: Options): ((args: unknown) => Promise<unknown>) => {
    const server = options.mcpServers?.["ui"] as { instance: unknown } | undefined;
    const registry = server?.instance as unknown as {
        _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
    };
    const registered = registry?.["_registeredTools"]?.["ask"];
    // Asserts against the registered tool list first, so a rename fails here with the list rather than as a TypeError
    // below.
    expect(Object.keys(registry?.["_registeredTools"] ?? {}), "no ask tool on the ui server").toContain("ask");
    return (args) => registered!.handler(args, {});
};

const QUESTIONS = [{ question: "How much of the fix?", header: "Scope", multiSelect: false, options: [{ label: "All", description: "…" }] }];

// Writes `path` (as the model spells it), settles the write with `outcome`, then asks a question.
const askAfterWriting = async (path: string, markdown: string, outcome: { is_error?: boolean } = {}): Promise<AgentEvent[]> => {
    withoutTmux();
    const frames: AgentEvent[] = [];
    const query: QueryFn = async function* (args) {
        yield {
            type: "assistant",
            session_id: "s",
            message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: path, content: markdown } }] },
        } as SDKMessage;
        yield {
            type: "user",
            session_id: "s",
            message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "ok", ...outcome }] },
        } as SDKMessage;
        await askTool(args.options)({ questions: QUESTIONS });
        yield { type: "result", subtype: "success" } as SDKMessage;
    };
    for await (const event of runAgent(request, query)) {
        frames.push(event);
        if (event.kind === "question") {
            resolveRequest({ kind: "question", requestId: event.requestId, answers: { "How much of the fix?": ["All"] } });
        }
    }
    return frames;
};

test("a question asked after a write-up carries the document, resolved onto the workspace path", async () => {
    const frames = await askAfterWriting(`${homedir()}/.claude/plans/wiggly-spring.md`, "# Why it is slow\n\nThe poll is the cost.");

    expect(frames.find((frame) => frame.kind === "question")?.document).toEqual({
        // The CLI writes its plans into a symlinked store; the card gets the workspace file, not a home path.
        path: `${STATE_DIR}/records/sessions/claude/plans/wiggly-spring.md`,
        title: "Why it is slow",
        markdown: "# Why it is slow\n\nThe poll is the cost.",
        plan: true,
    });
});

// A Write can still fail after being called; the question card must not attach a document that was never actually
// written.
test("a question carries nothing when the write it would be about failed", async () => {
    const frames = await askAfterWriting("docs/findings.md", "# Findings", { is_error: true });

    expect(frames.find((frame) => frame.kind === "question")?.document).toBeUndefined();
});

// Only a write-up for the reader attaches; ordinary source code written along the way does not.
test("a question after an ordinary source write carries nothing", async () => {
    const frames = await askAfterWriting("src/poll.ts", "export const poll = 1;");

    expect(frames.find((frame) => frame.kind === "question")?.document).toBeUndefined();
});

// If the written file is the real plan and the prose just summarises it, the card attaches the file; if the prose
// already is the complete plan, nothing attaches.
const planAfterWriting = async (markdown: string, plan: string | undefined, path = "docs/plan.md"): Promise<AgentEvent[]> => {
    withoutTmux();
    const frames: AgentEvent[] = [];
    const query: QueryFn = async function* (args) {
        yield {
            type: "assistant",
            session_id: "s",
            message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: path, content: markdown } }] },
        } as SDKMessage;
        yield { type: "user", session_id: "s", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }] } } as SDKMessage;
        if (plan !== undefined) {
            yield* proseBlock(plan, "s");
        }
        await args.options.canUseTool!("ExitPlanMode", {}, { signal: request.signal } as never);
        yield { type: "result", subtype: "success" } as SDKMessage;
    };
    for await (const event of runAgent(request, query)) {
        frames.push(event);
        if (event.kind === "plan") {
            resolveRequest({ kind: "plan", requestId: event.requestId, approve: true });
        }
    }
    return frames;
};

test("a plan that points at a write-up carries it, so approving is never a yes to something unseen", async () => {
    const frames = await planAfterWriting("# The plan\n\nStep one, at length, with the reasoning behind it.", "See docs/plan.md");

    expect(frames.find((frame) => frame.kind === "plan")?.document).toMatchObject({ path: "docs/plan.md", title: "The plan" });
});

test("a plan that IS the plan carries nothing: the card already holds it", async () => {
    const frames = await planAfterWriting("# Notes", "# The plan\n\nStep one, at length, with the reasoning behind it, in the card itself.");

    expect(frames.find((frame) => frame.kind === "plan")?.document).toBeUndefined();
});
