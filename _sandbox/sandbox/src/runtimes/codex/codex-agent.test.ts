import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import type { AgentRequest } from "../../agent/run/agent.js";
import { resolveRequest } from "../../agent/tools/agent-requests.js";
import { SteeringQueue } from "../../agent/anchors/agent-steering.js";
import { fakeCodexRunner } from "../../testing.js";
import type { CodexEvent, CodexRunner } from "./codex-app-server.js";
import { createCodexAgent } from "./codex-agent.js";

const createTestAgent = (runner: CodexRunner, codexHome = "/home") => createCodexAgent({ codexHome, runner });

const request = { prompt: "add a /ping route", cwd: WORKSPACE_ROOT, signal: new AbortController().signal };

// Collects all events; onPlan/onQuestion schedule their answer after the generator parks on the pending-request bridge,
// hence the setTimeout (the yield suspends before wait() registers).
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
        // untrusted on every turn: the standing floor means something could always refuse.
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
        // requestId lets a replaying client skip rebuilding and re-asking for the same plan card.
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

// A 400 naming a parameter never sent; coded a provider outage, not model-invalid, so it retries.
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
    // Provider's own words are kept, not a gloss, so the reader sees what was refused.
    expect(failure?.message).toContain("prompt_cache_retention");
    // Not the bad-pick code, which would make the client drop a pinned model that wasn't at fault.
    expect(failure?.code).not.toBe("codex-model-invalid");
});

// Codex's fallback-metadata warning; lands before turn.started for any uncompiled model.
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
    // An advisory must not mark the planning phase errored, or plan-emulation would abandon a turn that produced a
    // plan.
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

// Codex's resume warning, worded as codex-rs/core/src/session/mod.rs formats it when the thread's last recorded model
// isn't the one now picked. It fires on every resume after a model switch, including the automatic one this sandbox
// makes when a provider 503s.
const RESUMED_ELSEWHERE =
    "This session was recorded with model `gpt-5.6-sol` but is resuming with `gpt-6-astra`. " +
    "Consider switching back to `gpt-5.6-sol` as it may affect Codex performance.";

test("the resume model-mismatch warning is dropped, since switching model mid-thread is this chat's own move", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-15" },
        { type: "warning", message: RESUMED_ELSEWHERE },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } },
    ]);
    // No frame at all, not even the muted line: the chat already prints its own "Switched to ..." notice, and Codex's
    // advice to switch back argues with a model the reader picked on purpose.
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-15" },
        { kind: "delta", text: "ok" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

test("an unrecognized warning is muted rather than reddening the turn, and a plan turn still proposes its plan", async () => {
    // A warning that marked the phase errored would have plan-emulation abandon a turn the CLI only commented on.
    const WARNING = "Something the CLI wanted to mention.";
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-16" },
            { type: "warning", message: WARNING },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    const events = await collect(createTestAgent(runner), { ...request, permissionMode: "plan" as const }, () => ({ approve: true }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-16" },
        // Coded, so the client renders it muted: the warning channel by construction carries advisories, never failures.
        { kind: "error", code: "codex-advisory", message: WARNING },
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

// Codex's stream retry arrives as an error notification with retry counters and the reason in parens.
const STREAM_RETRY = "Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)";
const PROCESS_EXIT = "Codex app-server exited (1): connection closed";

test("an in-turn stream retry is a wait, not a failure: the turn's answer still lands", async () => {
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-11" },
        { type: "error", message: STREAM_RETRY },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "back" } },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-11" },
        // Same frame the Claude path emits for its own retries, so the loader line behaves the same across runtimes.
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
    // Retry notices must not count as this turn's surfaced error, or the real failure that follows would arrive silent.
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
    // surfacedError stops the exit wrapper from clobbering an actionable message; an advisory must not count as one.
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
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-13" },
        { type: "item.completed", item: { id: "compact-1", type: "context_compaction" } },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "carrying on" } },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-13" },
        // Same frame the Claude path yields off compact_boundary: a muted notice, nothing on the error channel.
        { kind: "compact", trigger: "auto" },
        { kind: "delta", text: "carrying on" },
        { kind: "text_end" },
        { kind: "done" },
    ]);
});

test("a plan turn survives a compaction and still proposes its plan", async () => {
    // A compaction marking the phase errored would drop a plan the turn really produced; plan turns are exactly the
    // long kind that hits the threshold.
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
    // The compact frame never touches surfacedError, so a turn that compacts and then really dies still gets the exit
    // wrapper's message.
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
    // Coded rate_limit for a muted reset countdown; auto-continue waits for the reset, not a hammering retry.
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

// Verbatim from the daemon log, minus the wrapping: the translator's answer when its Go transport never reached the
// model, which wears the same words as a plan that excludes it.
const DNS_STALL =
    "unexpected status 503 Service Unavailable: auth_unavailable: no auth available (providers=codex, model=gpt-6-astra; " +
    'last upstream error: Post "https://chatgpt.com/backend-api/codex/responses": utls: dial upstream: dial tcp: ' +
    "lookup chatgpt.com on 127.0.0.11:53: read udp 127.0.0.1:36274->127.0.0.11:53: i/o timeout), url: http://127.0.0.1:8789/v1/responses";

test("one failure reported on both of Codex's channels reddens the turn once", async () => {
    // app-server publishes a failure on its error notification AND in turn/completed; two frames would post the same
    // sentence to the chat twice, which is what the user sees.
    const failure = "Your workspace is out of credits.";
    const { runner } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-8" },
        { type: "error", message: failure },
        { type: "turn.failed", error: { message: failure } },
    ]);
    expect(await collect(createTestAgent(runner), request)).toEqual([
        { kind: "session", sessionId: "thr-8" },
        { kind: "error", message: failure },
        { kind: "done" },
    ]);
});

test("a turn the translator never got to the model is re-run, not surfaced", async () => {
    const { runner, calls } = fakeCodexRunner(
        [
            { type: "thread.started", thread_id: "thr-a" },
            { type: "error", message: DNS_STALL },
            { type: "turn.failed", error: { message: DNS_STALL } },
        ],
        [
            { type: "thread.started", thread_id: "thr-b" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Added the route." } },
        ],
    );
    vi.useFakeTimers();
    try {
        const events = collect(createTestAgent(runner), request);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(await events).toEqual([
            { kind: "session", sessionId: "thr-a" },
            { kind: "provider_retry", attempt: 1, maxAttempts: 3, nextAttemptAt: expect.any(Number) as number },
            { kind: "session", sessionId: "thr-b" },
            { kind: "delta", text: "Added the route." },
            { kind: "text_end" },
            { kind: "done" },
        ]);
    } finally {
        vi.useRealTimers();
    }
    expect(calls).toHaveLength(2);
});

test("the same failure after the turn did work is surfaced, since a re-run would repeat it", async () => {
    // The prompt is re-sent on a retry, so a transport failure only earns one while the attempt has nothing to lose.
    const { runner, calls } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-c" },
        {
            type: "item.completed",
            item: { id: "c1", type: "command_execution", command: "pnpm test", aggregated_output: "1 passed", exit_code: 0, status: "completed" },
        },
        { type: "turn.failed", error: { message: DNS_STALL } },
    ]);
    const events = await collect(createTestAgent(runner), request);
    expect(events.at(-2)).toEqual({ kind: "error", message: DNS_STALL });
    expect(calls).toHaveLength(1);
});

test("a transport failure that outlasts the retries is surfaced in the end", async () => {
    const { runner, calls } = fakeCodexRunner([
        { type: "thread.started", thread_id: "thr-d" },
        { type: "turn.failed", error: { message: DNS_STALL } },
    ]);
    vi.useFakeTimers();
    try {
        const events = collect(createTestAgent(runner), request);
        await vi.advanceTimersByTimeAsync(11_000);
        expect((await events).filter((event) => event.kind === "error")).toEqual([{ kind: "error", message: DNS_STALL }]);
    } finally {
        vi.useRealTimers();
    }
    // Three attempts: the two waits are the cap, and the third failure is the turn's answer.
    expect(calls).toHaveLength(3);
});

test("a streamed error survives the app-server process-exit throw", async () => {
    // The generic process-exit wrapper must not overwrite an actionable message Codex already streamed.
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
        // Typed while the plan card is up; that phase's channel already closed, so it belongs to the next one.
        queue.push("use fastify");
        return { approve: true };
    });

    expect(calls).toHaveLength(2);
    expect(steered).toEqual([[], ["use fastify"]]);
});

// Owner's safety policy on Codex, over item/commandExecution/requestApproval. The judge is a stub throughout; approval
// events are hand-built since what's checked is the verdict on respond.
const approvalTurn = (command: string, respond: (allow: boolean) => void): CodexRunner =>
    async function* () {
        yield { type: "thread.started", thread_id: "thr-a" };
        yield { type: "command_approval.requested", command, respond };
        yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } };
    };

// Stub judge: returns one constant verdict for whatever it's shown.
const judging =
    (decision: "allow" | "ask" | "refuse"): AgentRequest["judge"] =>
    async () => ({ decision, sentence: "It does the thing." });

test("a refused command declines rather than cancelling the turn", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("git push --force origin main", (allow) => decisions.push(allow)));

    const events = await collect(agent, { ...request, judge: judging("refuse") });

    expect(decisions).toEqual([false]);
    // The turn carried on past the refusal: the agent hears no and picks something else.
    expect(events.some((event) => event.kind === "done")).toBe(true);
});

test("an unclassified command is approved, so an ordinary turn is untouched", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("pnpm test", (allow) => decisions.push(allow)));

    await collect(agent, { ...request, judge: judging("refuse") });

    expect(decisions).toEqual([true]);
});

// Approvals fire on every turn, since triage and the hard rule are facts about the command, not the owner's config;
// most round-trips resolve to yes without the judge ever being asked.
test("approvals are requested on every turn, configured or not", async () => {
    const { runner, calls } = fakeCodexRunner([]);
    const agent = createTestAgent(runner);

    await collect(agent, request);
    expect(calls[0]!.options.approvalPolicy).toBe("untrusted");

    await collect(agent, { ...request, judge: judging("ask") });
    expect(calls[1]!.options.approvalPolicy).toBe("untrusted");

    // A turn woken by a stranger is gated too, which was already true under the taint floor.
    await collect(agent, { ...request, outsideWake: "discord" });
    expect(calls[2]!.options.approvalPolicy).toBe("untrusted");
});

// An ask parks the Codex turn on the same permission card a Bash hook raises; app-server blocks on the request, so
// nothing else arrives while it's read.
test("an asked command raises a permission card and approves it when the user allows", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("rm -rf build", (allow) => decisions.push(allow)));
    const events: AgentEvent[] = [];

    for await (const event of agent({ ...request, judge: judging("ask") })) {
        events.push(event);
        if (event.kind === "permission") {
            setTimeout(() => resolveRequest({ kind: "permission", requestId: event.requestId, decision: "once" }), 0);
        }
    }

    const card = events.find((event) => event.kind === "permission");
    // Reaches the card as a program, marked where the classifier fired, same shape as the Claude path's card.
    expect(card).toMatchObject({
        title: "It does the thing.",
        program: { text: "rm -rf build", language: "bash", spans: [{ start: 0, end: 12 }] },
    });
    expect(events.some((event) => event.kind === "resolved")).toBe(true);
    expect(decisions).toEqual([true]);
});

test("declining the card refuses the command", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("rm -rf build", (allow) => decisions.push(allow)));

    for await (const event of agent({ ...request, judge: judging("ask") })) {
        if (event.kind === "permission") {
            setTimeout(() => resolveRequest({ kind: "permission", requestId: event.requestId, decision: "deny" }), 0);
        }
    }

    expect(decisions).toEqual([false]);
});

test("an unattended turn refuses rather than raising a card", async () => {
    const decisions: boolean[] = [];
    const agent = createTestAgent(approvalTurn("rm -rf build", (allow) => decisions.push(allow)));

    const events = await collect(agent, { ...request, unattended: true, judge: judging("ask") });

    expect(decisions).toEqual([false]);
    expect(events.some((event) => event.kind === "permission")).toBe(false);
});
