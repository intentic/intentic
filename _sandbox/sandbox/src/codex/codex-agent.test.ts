import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { resolveRequest } from "../agent/agent-requests.js";
import { SteeringQueue } from "../agent/agent-steering.js";
import { fakeCodexRunner } from "../testing.js";
import type { CodexEvent, CodexRunner } from "./codex-app-server.js";
import { createCodexAgent } from "./codex-agent.js";

const createTestAgent = (runner: CodexRunner, codexHome = "/home") => createCodexAgent({ codexHome, runner });

const request = { prompt: "add a /ping route", cwd: WORKSPACE_ROOT, signal: new AbortController().signal };

// Collect all events; `onPlan`/`onQuestion` (when given) schedule an answer for each card AFTER the generator has
// parked on the pending-request bridge (the yield suspends before wait() registers, hence the macrotask).
const collect = async (
    agent: ReturnType<typeof createCodexAgent>,
    turnRequest: Parameters<ReturnType<typeof createCodexAgent>>[0],
    onPlan?: (requestId: string) => { approve: boolean; feedback?: string },
    onQuestion?: (requestId: string) => { answers?: Record<string, string[]>; cancelled?: boolean },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent(turnRequest)) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan(event.requestId);
            setTimeout(() => resolveRequest({ kind: "plan", requestId: event.requestId, ...decision }), 0);
        }
        if (event.kind === "question" && onQuestion !== undefined) {
            const decision = onQuestion(event.requestId);
            setTimeout(() => resolveRequest({ kind: "question", requestId: event.requestId, ...decision }), 0);
        }
    }
    return events;
};

test("a turn maps thread events onto session, deltas, thinking, tools, todos, usage, and done", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-1" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "r1", type: "reasoning", text: "planning the edit" } },
        { type: "item.started", item: { id: "c1", type: "command_execution", command: "pnpm test", aggregated_output: "", status: "in_progress" } },
        {
            type: "item.completed",
            item: { id: "c1", type: "command_execution", command: "pnpm test", aggregated_output: "1 passed", exit_code: 0, status: "completed" },
        },
        { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "src/app.ts", kind: "update" }], status: "completed" } },
        { type: "item.updated", item: { id: "t1", type: "todo_list", items: [{ text: "add route", completed: false }] } },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Added the route." } },
        {
            type: "turn.completed",
            usage: { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 2 },
        },
    ]);
    const events = await collect(createTestAgent(runner, `${WORKSPACE_ROOT}/${STATE_DIR}/secrets/auth/codex`), request);
    expect(events).toEqual([
        { kind: "session", sessionId: "thr-1" },
        { kind: "thinking", text: "planning the edit" },
        { kind: "tool_call", id: "c1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
        { kind: "tool_call_update", id: "c1", status: "completed", content: [{ type: "text", text: "1 passed" }] },
        {
            kind: "tool_call",
            id: "f1",
            name: "Edit",
            category: "edit",
            status: "completed",
            target: "update src/app.ts",
            locations: [{ path: "src/app.ts" }],
        },
        { kind: "todos", items: [{ content: "add route", status: "pending" }] },
        { kind: "delta", text: "Added the route." },
        // Codex only reports a completed agent_message, so every delta is a whole prose block and closes one.
        { kind: "text_end" },
        { kind: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 1 },
        { kind: "done" },
    ]);
});

test("the turn runs full-access with approvals off, resumes the session, and pins CODEX_HOME", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner, `${WORKSPACE_ROOT}/${STATE_DIR}/secrets/auth/codex`), {
        ...request,
        sessionId: "thr-9",
        model: "gpt-5-codex",
        effort: "max",
        cliEnv: { DISCORD_BOT_TOKEN: "tok" },
    });
    expect(calls).toHaveLength(1);
    const turn = calls[0]!;
    expect(turn.sessionId).toBe("thr-9");
    expect(turn.options).toEqual({
        workingDirectory: "/work",
        sandboxMode: "danger-full-access",
        // "untrusted" on every turn now: the standing floor means there is always something that could refuse.
        approvalPolicy: "untrusted",
        model: "gpt-5-codex",
        // Claude's top effort level maps onto Codex's scale ceiling.
        modelReasoningEffort: "xhigh",
    });
    expect(turn.env["CODEX_HOME"]).toBe("/work/.intentic/secrets/auth/codex");
    expect(turn.env["DISCORD_BOT_TOKEN"]).toBe("tok");
});

test("a subscription turn uses the translator bearer and the actor marker that unlocks image generation", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner, `${WORKSPACE_ROOT}/${STATE_DIR}/secrets/auth/codex`), {
        ...request,
        model: "gpt-5.5",
        codexEndpoint: { baseUrl: "http://127.0.0.1:8788", authToken: "intentic-translator-local" },
    });
    const turn = calls[0]!;
    // The bearer rides CODEX_API_KEY (env_key), not an OAuth token in a home.
    expect(turn.env["CODEX_API_KEY"]).toBe("intentic-translator-local");
    // A full model_providers block pinned to the translator's /v1, Responses wire format, WS disabled.
    expect(turn.modelProvider).toBe("translator");
    expect(turn.config).toEqual({
        "model_providers.translator": {
            name: "translator",
            base_url: "http://127.0.0.1:8788/v1",
            wire_api: "responses",
            env_key: "CODEX_API_KEY",
            http_headers: { "x-openai-actor-authorization": "intentic" },
            supports_websockets: false,
        },
        "tools.experimental_request_user_input.enabled": true,
    });
});

test("a native (account) turn carries no provider config: Codex uses its own credential resolution", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner, `${WORKSPACE_ROOT}/${STATE_DIR}/secrets/auth/codex`), { ...request, model: "gpt-5-codex" });
    // The question tool is the one key every turn carries; nothing here names a provider or a credential.
    expect(calls[0]!.config).toEqual({ "tools.experimental_request_user_input.enabled": true });
    expect(calls[0]!.env["CODEX_API_KEY"]).toBeUndefined();
});

test("process-backed browser MCP servers ride Codex's per-thread config", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner), {
        ...request,
        sdkServers: {
            identity: {
                type: "stdio",
                command: "/usr/bin/socat",
                args: ["STDIO", "UNIX-CONNECT:/tmp/identity.sock"],
                // PATH is inherited and must not be copied into thread config; DISPLAY is a real server delta.
                env: { PATH: process.env["PATH"] ?? "", DISPLAY: ":99" },
                timeout: 120_000,
                alwaysLoad: true,
            },
        },
    });

    expect(calls[0]!.config).toEqual({
        "mcp_servers.identity": {
            command: "/usr/bin/socat",
            args: ["STDIO", "UNIX-CONNECT:/tmp/identity.sock"],
            env: { DISPLAY: ":99" },
            tool_timeout_sec: 120,
        },
        "tools.experimental_request_user_input.enabled": true,
    });
});

test("a failed command surfaces its output as a failed update", async () => {
    const { runner } = fakeCodexRunner([
        {
            type: "item.completed",
            item: { id: "c1", type: "command_execution", command: "pnpm test", aggregated_output: "1 failed", exit_code: 1, status: "failed" },
        },
    ]);
    const events = await collect(createTestAgent(runner), request);
    expect(events).toEqual([
        { kind: "tool_call_update", id: "c1", status: "failed", content: [{ type: "text", text: "1 failed" }] },
        { kind: "done" },
    ]);
});

test("attached images ride as native inputs while other files are referenced in the prompt", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner), {
        ...request,
        attachments: [
            `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/attachments/a/shot.png`,
            `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/attachments/b/report.pdf`,
        ],
    });
    expect(calls[0]!.images).toEqual(["/work/.intentic/records/artifacts/attachments/a/shot.png"]);
    expect(calls[0]!.prompt).toContain("/work/.intentic/records/artifacts/attachments/b/report.pdf");
    expect(calls[0]!.prompt).not.toContain("shot.png");
});

test("a plan turn sends attached images on the first planning turn only: the resumed thread keeps them", async () => {
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-6" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    await collect(createTestAgent(runner), { ...request, permissionMode: "plan" as const, attachments: [`${WORKSPACE_ROOT}/a/shot.png`] }, () => ({
        approve: true,
    }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.images).toEqual(["/work/a/shot.png"]);
    expect(calls[1]!.images).toBeUndefined();
});

test("a plan turn proposes read-only, then executes full-access on the same thread after approval", async () => {
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-2" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route, then test." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    const events = await collect(createTestAgent(runner), { ...request, permissionMode: "plan" as const }, () => ({ approve: true }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-2" },
        { kind: "plan", requestId: expect.any(String) as string, text: "Plan: add the route, then test." },
        // The card's release, carrying the id it went up with: what tells the fleet the turn stopped waiting,
        // and the approval itself, which is what stops a client replaying this run from rebuilding the plan
        // card and asking to have it approved all over again.
        {
            kind: "resolved",
            requestId: expect.any(String) as string,
            reply: { kind: "plan", requestId: expect.any(String) as string, approve: true },
        },
        { kind: "delta", text: "Done." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.options.sandboxMode).toBe("read-only");
    expect(calls[0]!.prompt).toContain("add a /ping route");
    expect(calls[1]!.sessionId).toBe("thr-2");
    expect(calls[1]!.options.sandboxMode).toBe("danger-full-access");
});

test("a rejected plan loops another read-only planning turn carrying the feedback", async () => {
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-3" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan v1" } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Plan v2" } }],
        [{ type: "item.completed", item: { id: "m3", type: "agent_message", text: "Executed." } }],
    );
    let planCount = 0;
    const events = await collect(createTestAgent(runner), { ...request, permissionMode: "plan" as const }, () => {
        planCount += 1;
        return planCount === 1 ? { approve: false, feedback: "use fastify" } : { approve: true };
    });

    expect(events.filter((event) => event.kind === "plan").map((event) => (event as { text: string }).text)).toEqual(["Plan v1", "Plan v2"]);
    expect(events.slice(-3)).toEqual([{ kind: "delta", text: "Executed." }, { kind: "text_end" }, { kind: "done" }]);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.prompt).toContain("use fastify");
    expect(calls[1]!.options.sandboxMode).toBe("read-only");
    expect(calls[1]!.sessionId).toBe("thr-3");
});

test("a plan turn that fails after holding a message emits the error and NO plan frame", async () => {
    // The plan phase held an agent_message, then the turn failed (e.g. out of credits). A failed turn must surface
    // only the error: never a "plan" built from the pre-error message, and must not run the execute turn.
    const { runner, calls } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-7" },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Partial plan." } },
        { type: "turn.failed", error: { message: "Payment Required" } },
    ]);
    const events = await collect(createTestAgent(runner), { ...request, permissionMode: "plan" as const });
    expect(events).toEqual([{ kind: "session", sessionId: "thr-7" }, { kind: "error", message: "Payment Required" }, { kind: "done" }]);
    expect(events.some((event) => event.kind === "plan")).toBe(false);
    expect(calls).toHaveLength(1);
});

/* THE FAILURE THAT COST A TEN-MINUTE TURN. The provider refused its OWN cache-retention default at the end of a
 * long run, in a sentence ending "on this model", and the turn died with a red line: nothing was resumed,
 * because a 400 reads as the request's fault, and nothing here sends that parameter to fix. Coded as the outage
 * it is, the daemon's breaker re-runs the turn from the session it already built (turn-resume.ts).
 *
 * The sentence ending in "this model" is also why the ORDER is pinned here: the model-invalid branch would have
 * claimed it and made the client drop the user's pinned model over a fault that was never the pick's. */
const UNSENT_PARAMETER_400 =
    '{"error":{"type":"invalid_request_error","code":"invalid_parameter","message":"prompt_cache_retention is not supported on this model","param":"prompt_cache_retention"}}';

test("a parameter the turn never sent is coded as an outage, so the turn comes back instead of dying", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-9" },
        { type: "turn.failed", error: { message: UNSENT_PARAMETER_400 } },
    ]);
    const events = await collect(createTestAgent(runner), request);
    const failure = events.find((event) => event.kind === "error") as { code?: string; message: string } | undefined;
    expect(failure?.code).toBe("provider-outage");
    // The provider's own words are kept, so the reader sees what was refused, not just our gloss on it.
    expect(failure?.message).toContain("prompt_cache_retention is not supported on this model");
    // NOT the bad-pick code: that one makes the client throw away a pinned model that had nothing to do with it.
    expect(failure?.code).not.toBe("codex-model-invalid");
});

// Codex's fallback-metadata warning lands before turn.started, after which the turn answers normally. Every
// model the subscription serves but the pinned CLI has no compiled-in metadata for emits one.
const ADVISORY = "Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";

test("a non-fatal advisory is tagged rather than surfaced as a failure, and the turn's answer still lands", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-8" },
        { type: "error", message: ADVISORY },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-8" },
        // Coded, so the client renders a muted notice instead of the red error line under a turn that worked.
        { kind: "error", code: "codex-advisory", message: ADVISORY },
        { kind: "delta", text: "ok" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

test("a plan turn survives an advisory and still proposes its plan", async () => {
    // The regression this covers: the advisory marked the planning phase errored, so plan-emulation abandoned the
    // turn: picking any gpt-5.6 model in Plan mode produced a red line, no plan card, and no execution.
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-10" },
            { type: "error", message: ADVISORY },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    const events = await collect(createTestAgent(runner), { ...request, permissionMode: "plan" as const }, () => ({ approve: true }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-10" },
        { kind: "error", code: "codex-advisory", message: ADVISORY },
        { kind: "plan", requestId: expect.any(String) as string, text: "Plan: add the route." },
        {
            kind: "resolved",
            requestId: expect.any(String) as string,
            reply: { kind: "plan", requestId: expect.any(String) as string, approve: true },
        },
        { kind: "delta", text: "Done." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
    // The approved plan really executed: a second, full-access turn on the same thread.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options.sandboxMode).toBe("danger-full-access");
});

// Codex's in-turn stream retry arrives as an app-server error notification carrying the retry counters its own
// loop minted and the transport reason in parentheses. The turn keeps going.
const STREAM_RETRY = "Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)";
const PROCESS_EXIT = "Codex app-server exited (1): connection closed";

test("an in-turn stream retry is a wait, not a failure: the turn's answer still lands", async () => {
    // The incident: this frame put a red error line under a turn that then answered normally four minutes later.
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-11" },
        { type: "error", message: STREAM_RETRY },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "back" } },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-11" },
        // The same frame the Claude path emits for its own in-turn retries: the chat's loader line says the turn
        // is waiting, and the next frame retires it.
        { kind: "provider_retry", attempt: 1, maxAttempts: 5 },
        { kind: "delta", text: "back" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

test("a plan turn survives a stream retry and still proposes its plan", async () => {
    // A retry that marked the phase errored would have plan-emulation abandon a turn the CLI recovered by itself.
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-12" },
            { type: "error", message: STREAM_RETRY },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    const events = await collect(createTestAgent(runner), { ...request, permissionMode: "plan" as const }, () => ({ approve: true }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-12" },
        { kind: "provider_retry", attempt: 1, maxAttempts: 5 },
        { kind: "plan", requestId: expect.any(String) as string, text: "Plan: add the route." },
        {
            kind: "resolved",
            requestId: expect.any(String) as string,
            reply: { kind: "plan", requestId: expect.any(String) as string, approve: true },
        },
        { kind: "delta", text: "Done." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
    expect(calls).toHaveLength(2);
});

test("a stream retry doesn't stand in for the real failure when the retries run out", async () => {
    // Codex retries five times and then fails for real. The retry notices must not count as this turn's surfaced
    // error, or the failure that follows them would arrive silent.
    const runner: CodexRunner = async function* () {
        yield { type: "error", message: STREAM_RETRY } as CodexEvent;
        throw new Error(PROCESS_EXIT);
    };
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "provider_retry", attempt: 1, maxAttempts: 5 },
        { kind: "error", message: PROCESS_EXIT },
        { kind: "done" },
    ]);
});

test("an advisory doesn't stand in for the real failure when the turn then dies", async () => {
    // surfacedError exists to stop the process transport's generic exit wrapper from clobbering an actionable message.
    // An advisory is not that message: counting it as one would leave a genuinely failed turn silent.
    const runner: CodexRunner = async function* () {
        yield { type: "error", message: ADVISORY } as CodexEvent;
        throw new Error(PROCESS_EXIT);
    };
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "error", code: "codex-advisory", message: ADVISORY },
        { kind: "error", message: PROCESS_EXIT },
        { kind: "done" },
    ]);
});

test("a context-compaction item is the compact lifecycle frame, and the turn's answer still lands", async () => {
    // The incident: every long Sol turn ended with the red error line, directly under the answer it had just
    // produced: a thread that auto-compacts at ~90% of the window earns one of these for each compaction.
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-13" },
        { type: "item.completed", item: { id: "compact-1", type: "context_compaction" } },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "carrying on" } },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-13" },
        // The frame the Claude path already yields off compact_boundary: one muted "context compacted" notice in
        // the chat for both providers, and nothing on the error channel to write turn.error or redden the card.
        { kind: "compact", trigger: "auto" },
        { kind: "delta", text: "carrying on" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

test("a plan turn survives a compaction and still proposes its plan", async () => {
    // A compaction that marked the phase errored would have plan-emulation drop a plan the turn really produced:
    // and a plan turn is exactly the long, tool-heavy kind that reaches the compaction threshold.
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-14" },
            { type: "item.completed", item: { id: "compact-1", type: "context_compaction" } },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    const events = await collect(createTestAgent(runner), { ...request, permissionMode: "plan" as const }, () => ({ approve: true }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-14" },
        { kind: "compact", trigger: "auto" },
        { kind: "plan", requestId: expect.any(String) as string, text: "Plan: add the route." },
        {
            kind: "resolved",
            requestId: expect.any(String) as string,
            reply: { kind: "plan", requestId: expect.any(String) as string, approve: true },
        },
        { kind: "delta", text: "Done." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
    expect(calls).toHaveLength(2);
});

test("a compaction doesn't stand in for the real failure when the turn then dies", async () => {
    // A turn can compact and THEN die for a real reason. The compact frame never touches surfacedError, so the
    // app-server process-exit wrapper still gets to speak rather than the turn ending silent.
    const runner: CodexRunner = async function* () {
        yield { type: "item.completed", item: { id: "compact-1", type: "context_compaction" } } as CodexEvent;
        throw new Error(PROCESS_EXIT);
    };
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "compact", trigger: "auto" },
        { kind: "error", message: PROCESS_EXIT },
        { kind: "done" },
    ]);
});

test("turn failures and thrown runners become error events followed by done", async () => {
    const failing = fakeCodexRunner([{ type: "turn.failed", error: { message: "usage limit reached" } }]);
    // A spent-allowance message is coded rate_limit so the client treats it as a muted notice with a reset
    // countdown rather than a red crash line, and auto-continue schedules at the reset instead of retrying
    // every 5 seconds into a closed window.
    expect(await collect(createTestAgent(failing.runner), request)).toEqual([
        { kind: "error", code: "rate_limit", message: "usage limit reached" },
        { kind: "done" },
    ]);

    const throwing: CodexRunner = async function* () {
        yield { type: "thread.started", thread_id: "thr-4" } as CodexEvent;
        throw new Error("app-server connection failed");
    };
    expect(await collect(createTestAgent(throwing), request)).toEqual([
        { kind: "session", sessionId: "thr-4" },
        { kind: "error", message: "app-server connection failed" },
        { kind: "done" },
    ]);
});

test("a streamed error survives the app-server process-exit throw", async () => {
    // Codex streams the real cause (e.g. out of credits), then exits non-zero. The generic process wrapper must
    // not overwrite the actionable message already surfaced.
    const runner: CodexRunner = async function* () {
        yield { type: "thread.started", thread_id: "thr-5" } as CodexEvent;
        yield { type: "turn.failed", error: { message: "Your workspace is out of credits." } } as CodexEvent;
        throw new Error(PROCESS_EXIT);
    };
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-5" },
        { kind: "error", message: "Your workspace is out of credits." },
        { kind: "done" },
    ]);
});

test("the thread's skills become the composer's command list", async () => {
    const { runner } = fakeCodexRunner([
        { type: "commands", skills: [{ name: "release", description: "Cut a release", path: "/work/.codex/skills/release" }] },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "commands", items: [{ name: "release", description: "Cut a release" }] },
        { kind: "done" },
    ]);
});

test("a Codex question becomes the same card the ask tool raises, and the picks travel back on the request", async () => {
    const answered: Record<string, readonly string[]>[] = [];
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-q" },
        {
            type: "user_input.requested",
            questions: [
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
            ],
            respond: (answers) => answered.push(answers),
        },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Using Google." } },
    ]);

    const events = await collect(createTestAgent(runner), request, undefined, () => ({
        answers: { "Which sign-in should the route accept?": ["Google"] },
    }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-q" },
        {
            kind: "question",
            requestId: expect.any(String) as string,
            questions: [
                {
                    question: "Which sign-in should the route accept?",
                    header: "Auth",
                    // Codex publishes no multi-select flag, so every card it raises is single-pick.
                    multiSelect: false,
                    options: [
                        { label: "Google", description: "SSO through the connected account" },
                        { label: "Email", description: "A code sent to the address" },
                    ],
                },
            ],
        },
        {
            kind: "resolved",
            requestId: expect.any(String) as string,
            reply: {
                kind: "question",
                requestId: expect.any(String) as string,
                answers: { "Which sign-in should the route accept?": ["Google"] },
            },
        },
        { kind: "delta", text: "Using Google." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
    expect(answered).toEqual([{ q1: ["Google"] }]);
});

test("a dismissed question tells Codex so rather than leaving it holding the request", async () => {
    const answered: Record<string, readonly string[]>[] = [];
    const { runner } = fakeCodexRunner([
        {
            type: "user_input.requested",
            questions: [{ id: "q1", header: "Auth", question: "Which sign-in?", options: [], secret: false }],
            respond: (answers) => answered.push(answers),
        },
    ]);

    await collect(createTestAgent(runner), request, undefined, () => ({ cancelled: true }));

    expect(answered).toEqual([{ q1: ["The user dismissed the questions without answering and stopped the turn."] }]);
});

test("an unattended turn is given no way to ask: a card nobody will answer is a deadlock", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    await collect(createTestAgent(runner), { ...request, unattended: true });
    // Turned off by name, not by omission: Codex registers the tool when the table is absent.
    expect(calls[0]!.config).toEqual({ "tools.experimental_request_user_input.enabled": false });
});

test("a question for a secret is refused without a card, because a card's answers are recorded", async () => {
    const answered: Record<string, readonly string[]>[] = [];
    const { runner } = fakeCodexRunner([
        {
            type: "user_input.requested",
            questions: [{ id: "key", header: "Key", question: "Paste the API key", options: [], secret: true }],
            respond: (answers) => answered.push(answers),
        },
    ]);

    const events = await collect(createTestAgent(runner), request);

    expect(events.some((event) => event.kind === "question")).toBe(false);
    expect(answered[0]?.["key"]?.[0]).toContain("does not collect secrets");
});

test("an anchored turn's app-server is born in the turn's mount namespace", async () => {
    const plan = { worktree: "/history/worktrees/c1/work", root: WORKSPACE_ROOT, mirrors: [], overlays: "/history/overlays/c1" };
    const { runner, calls } = fakeCodexRunner([]);

    await collect(createTestAgent(runner), {
        ...request,
        isolation: { plan, anchor: { pid: 4321, cwd: WORKSPACE_ROOT, plan, dispose: () => {} } },
    });

    expect(calls[0]!.namespace).toEqual({ pid: 4321, cwd: WORKSPACE_ROOT });
});

test("an isolated turn the container could not anchor carries no namespace and runs cwd'd as before", async () => {
    const plan = { worktree: "/history/worktrees/c1/work", root: WORKSPACE_ROOT, mirrors: [], overlays: "/history/overlays/c1" };
    const { runner, calls } = fakeCodexRunner([]);

    await collect(createTestAgent(runner), { ...request, cwd: plan.worktree, isolation: { plan } });

    expect(calls[0]!.namespace).toBeUndefined();
    expect(calls[0]!.options.workingDirectory).toBe(plan.worktree);
});

test("each turn gets a steering channel, and one typed while the plan is read reaches the execution phase", async () => {
    const queue = new SteeringQueue();
    const { runner, calls, steered } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-s" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );

    await collect(createTestAgent(runner), { ...request, permissionMode: "plan" as const, steering: queue }, () => {
        // Typed while the plan card is up: the planning phase's channel has already closed, so this message
        // belongs to the phase that has not started yet.
        queue.push("use fastify");
        return { approve: true };
    });

    expect(calls).toHaveLength(2);
    expect(steered).toEqual([[], ["use fastify"]]);
});

/* THE OWNER'S COMMAND RULEBOOK ON CODEX, over `item/commandExecution/requestApproval`. Before this, `commandRules`
 * was silently a Claude Code setting: a turn on this runtime was never asked and never refused.
 *
 * The approval event is built by hand rather than through fakeCodexRunner's list, because what is being checked
 * is the VERDICT that travels back on its `respond`. */
const approvalTurn = (command: string, respond: (allow: boolean) => void): CodexRunner =>
    async function* () {
        yield { type: "thread.started", thread_id: "thr-a" };
        yield { type: "command_approval.requested", command, respond };
        yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } };
    };

test("a denied class is refused, and the refusal declines rather than cancelling the turn", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("git push --force origin main", (allow) => decisions.push(allow)));

    const events = await collect(agent, { ...request, commandRules: { "git.destructive": "deny" } });

    expect(decisions).toEqual([false]);
    // The turn carried on past the refusal: the agent hears no and picks something else.
    expect(events.some((event) => event.kind === "done")).toBe(true);
});

test("an unclassified command is approved, so an ordinary turn is untouched", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("pnpm test", (allow) => decisions.push(allow)));

    await collect(agent, { ...request, commandRules: { "git.destructive": "deny" } });

    expect(decisions).toEqual([true]);
});

/* Codex raises approvals whenever the gate has something it could refuse, which is now EVERY turn: the
 * standing floor holds the classes nothing undoes even on a workspace nobody configured. That is the cost this
 * change accepts and the reason it is written down twice (guard/turn-gate.ts states it too) — an approval
 * round-trip per command execution, in exchange for a default that binds on every runtime rather than only on
 * the one whose hook is always wired. The floor is narrow enough that the round-trip is nearly always a yes. */
test("approvals are requested on every turn, configured or not", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    const agent = createTestAgent(runner);

    await collect(agent, request);
    expect(calls[0]!.options.approvalPolicy).toBe("untrusted");

    await collect(agent, { ...request, commandRules: { "files.destructive": "hold" } });
    expect(calls[1]!.options.approvalPolicy).toBe("untrusted");

    // A turn a stranger woke is gated too, which was already true: that is the taint floor's condition.
    await collect(agent, { ...request, outsideWake: "discord" });
    expect(calls[2]!.options.approvalPolicy).toBe("untrusted");
});

/* A HOLD PARKS THE CODEX TURN on the same permission card a Bash hook raises, which is the behaviour that could
 * not exist before: app-server is blocked on the approval request, so nothing of the turn's arrives while a
 * person reads it. */
test("a held class raises a permission card and approves the command when the user allows it", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("rm -rf build", (allow) => decisions.push(allow)));
    const events: AgentEvent[] = [];

    for await (const event of agent({ ...request, commandRules: { "files.destructive": "hold" } })) {
        events.push(event);
        if (event.kind === "permission") {
            setTimeout(() => resolveRequest({ kind: "permission", requestId: event.requestId, decision: "once" }), 0);
        }
    }

    const card = events.find((event) => event.kind === "permission");
    // The vendor's command reaches the card as a PROGRAM, marked where the classifier fired, exactly as the
    // Claude path's does: one gate, one card, whichever runtime carried the call.
    expect(card).toMatchObject({
        title: expect.stringContaining("delete files recursively"),
        program: { text: "rm -rf build", language: "bash", spans: [{ start: 0, end: 12 }] },
    });
    expect(events.some((event) => event.kind === "resolved")).toBe(true);
    expect(decisions).toEqual([true]);
});

test("declining the card refuses the command", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("rm -rf build", (allow) => decisions.push(allow)));

    for await (const event of agent({ ...request, commandRules: { "files.destructive": "hold" } })) {
        if (event.kind === "permission") {
            setTimeout(() => resolveRequest({ kind: "permission", requestId: event.requestId, decision: "deny" }), 0);
        }
    }

    expect(decisions).toEqual([false]);
});

// Nobody is at a composer, so the hold is delivered as a refusal instead of a card that would hang the turn.
test("an unattended turn refuses a held class rather than raising a card", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("rm -rf build", (allow) => decisions.push(allow)));

    const events = await collect(agent, { ...request, unattended: true, commandRules: { "files.destructive": "hold" } });

    expect(decisions).toEqual([false]);
    expect(events.some((event) => event.kind === "permission")).toBe(false);
});
