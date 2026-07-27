import type { ThreadEvent } from "@openai/codex-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { resolveRequest } from "../agent/agent-requests.js";
import { type CodexRunner, type CodexTurn, createCodexAgent } from "./codex-agent.js";

// A fake runner yielding one canned ThreadEvent list per invocation (plan turns invoke it repeatedly),
// capturing each turn's prompt/session/options/env — no CLI, no network.
const fakeRunner = (...turns: ThreadEvent[][]): { runner: CodexRunner; calls: CodexTurn[] } => {
    const calls: CodexTurn[] = [];
    const runner: CodexRunner = async function* (turn) {
        calls.push(turn);
        yield* turns[Math.min(calls.length - 1, turns.length - 1)] ?? [];
    };
    return { runner, calls };
};

const request = { prompt: "add a /ping route", cwd: "/work", signal: new AbortController().signal };

// Collect all events; `onPlan` (when given) schedules a decision for each plan frame AFTER the generator has
// parked on the pending-plan bridge (the yield suspends before wait() registers, hence the macrotask).
const collect = async (
    agent: ReturnType<typeof createCodexAgent>,
    turnRequest: Parameters<ReturnType<typeof createCodexAgent>>[0],
    onPlan?: (requestId: string) => { approve: boolean; feedback?: string },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent(turnRequest)) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan(event.requestId);
            setTimeout(() => resolveRequest({ kind: "plan", requestId: event.requestId, ...decision }), 0);
        }
    }
    return events;
};

test("a turn maps thread events onto session, deltas, thinking, tools, todos, usage, and done", async () => {
    const { runner } = fakeRunner([
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
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 2 } },
    ]);
    const events = await collect(createCodexAgent("/work/.intentic/codex", runner), request);
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
        { kind: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
        { kind: "done" },
    ]);
});

test("the turn runs full-access with approvals off, resumes the session, and pins CODEX_HOME", async () => {
    const { runner, calls } = fakeRunner([]);
    await collect(createCodexAgent("/work/.intentic/codex", runner), {
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
        skipGitRepoCheck: true,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        model: "gpt-5-codex",
        // Claude's top effort level maps onto Codex's scale ceiling.
        modelReasoningEffort: "xhigh",
    });
    expect(turn.env["CODEX_HOME"]).toBe("/work/.intentic/codex");
    expect(turn.env["DISCORD_BOT_TOKEN"]).toBe("tok");
});

test("a subscription-served turn (codexEndpoint) rides the translator provider block on the local bearer, no auth.json", async () => {
    const { runner, calls } = fakeRunner([]);
    await collect(createCodexAgent("/work/.intentic/codex", runner), {
        ...request,
        model: "gpt-5.5",
        codexEndpoint: { baseUrl: "http://127.0.0.1:8788", authToken: "intentic-translator-local" },
    });
    const turn = calls[0]!;
    // The bearer rides CODEX_API_KEY (env_key), not an OAuth token in a home.
    expect(turn.env["CODEX_API_KEY"]).toBe("intentic-translator-local");
    // A full model_providers block pinned to the translator's /v1, Responses wire format, WS disabled.
    expect(turn.config).toEqual({
        model_provider: "translator",
        model_providers: {
            translator: {
                name: "translator",
                base_url: "http://127.0.0.1:8788/v1",
                wire_api: "responses",
                env_key: "CODEX_API_KEY",
                supports_websockets: false,
            },
        },
    });
});

test("a native (account) turn carries no provider config — Codex uses its own credential resolution", async () => {
    const { runner, calls } = fakeRunner([]);
    await collect(createCodexAgent("/work/.intentic/codex", runner), { ...request, model: "gpt-5-codex" });
    expect(calls[0]!.config).toBeUndefined();
    expect(calls[0]!.env["CODEX_API_KEY"]).toBeUndefined();
});

test("a failed command surfaces its output as a failed update", async () => {
    const { runner } = fakeRunner([
        {
            type: "item.completed",
            item: { id: "c1", type: "command_execution", command: "pnpm test", aggregated_output: "1 failed", exit_code: 1, status: "failed" },
        },
    ]);
    const events = await collect(createCodexAgent("/home", runner), request);
    expect(events).toEqual([
        { kind: "tool_call_update", id: "c1", status: "failed", content: [{ type: "text", text: "1 failed" }] },
        { kind: "done" },
    ]);
});

test("attached images ride as native inputs while other files are referenced in the prompt", async () => {
    const { runner, calls } = fakeRunner([]);
    await collect(createCodexAgent("/home", runner), {
        ...request,
        attachments: ["/work/.intentic/attachments/a/shot.png", "/work/.intentic/attachments/b/report.pdf"],
    });
    expect(calls[0]!.images).toEqual(["/work/.intentic/attachments/a/shot.png"]);
    expect(calls[0]!.prompt).toContain("/work/.intentic/attachments/b/report.pdf");
    expect(calls[0]!.prompt).not.toContain("shot.png");
});

test("a plan turn sends attached images on the first planning turn only — the resumed thread keeps them", async () => {
    const { runner, calls } = fakeRunner(
        [
            { type: "thread.started", thread_id: "thr-6" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    await collect(createCodexAgent("/home", runner), { ...request, permissionMode: "plan" as const, attachments: ["/work/a/shot.png"] }, () => ({
        approve: true,
    }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.images).toEqual(["/work/a/shot.png"]);
    expect(calls[1]!.images).toBeUndefined();
});

test("a plan turn proposes read-only, then executes full-access on the same thread after approval", async () => {
    const { runner, calls } = fakeRunner(
        [
            { type: "thread.started", thread_id: "thr-2" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route, then test." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    const events = await collect(createCodexAgent("/home", runner), { ...request, permissionMode: "plan" as const }, () => ({ approve: true }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-2" },
        { kind: "plan", requestId: expect.any(String) as string, text: "Plan: add the route, then test." },
        // The card's release, carrying the id it went up with — what tells the fleet the turn stopped waiting.
        { kind: "resolved", requestId: expect.any(String) as string },
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
    const { runner, calls } = fakeRunner(
        [
            { type: "thread.started", thread_id: "thr-3" },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan v1" } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Plan v2" } }],
        [{ type: "item.completed", item: { id: "m3", type: "agent_message", text: "Executed." } }],
    );
    let planCount = 0;
    const events = await collect(createCodexAgent("/home", runner), { ...request, permissionMode: "plan" as const }, () => {
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
    // only the error — never a "plan" built from the pre-error message — and must not run the execute turn.
    const { runner, calls } = fakeRunner([
        { type: "thread.started", thread_id: "thr-7" },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Partial plan." } },
        { type: "turn.failed", error: { message: "Payment Required" } },
    ]);
    const events = await collect(createCodexAgent("/home", runner), { ...request, permissionMode: "plan" as const });
    expect(events).toEqual([{ kind: "session", sessionId: "thr-7" }, { kind: "error", message: "Payment Required" }, { kind: "done" }]);
    expect(events.some((event) => event.kind === "plan")).toBe(false);
    expect(calls).toHaveLength(1);
});

// Codex's fallback-metadata warning, verbatim off `codex exec --json`: an `error` ITEM that lands before
// turn.started, after which the turn answers normally. Every model the subscription serves but the pinned CLI
// has no compiled-in metadata for emits one — currently the whole gpt-5.6 line.
const ADVISORY = "Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";

test("a non-fatal advisory is tagged rather than surfaced as a failure, and the turn's answer still lands", async () => {
    const { runner } = fakeRunner([
        { type: "thread.started", thread_id: "thr-8" },
        { type: "item.completed", item: { id: "e1", type: "error", message: ADVISORY } },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } },
    ]);
    expect(await collect(createCodexAgent("/home", runner), request)).toEqual([
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
    // turn — picking any gpt-5.6 model in Plan mode produced a red line, no plan card, and no execution.
    const { runner, calls } = fakeRunner(
        [
            { type: "thread.started", thread_id: "thr-10" },
            { type: "item.completed", item: { id: "e1", type: "error", message: ADVISORY } },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Plan: add the route." } },
        ],
        [{ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Done." } }],
    );
    const events = await collect(createCodexAgent("/home", runner), { ...request, permissionMode: "plan" as const }, () => ({ approve: true }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-10" },
        { kind: "error", code: "codex-advisory", message: ADVISORY },
        { kind: "plan", requestId: expect.any(String) as string, text: "Plan: add the route." },
        { kind: "delta", text: "Done." },
        { kind: "text_end" },
        { kind: "done" },
    ]);
    // The approved plan really executed: a second, full-access turn on the same thread.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options.sandboxMode).toBe("danger-full-access");
});

test("an advisory doesn't stand in for the real failure when the turn then dies", async () => {
    // surfacedError exists to stop the SDK's generic exit-code wrapper from clobbering an actionable message.
    // An advisory is not that message — counting it as one would leave a genuinely failed turn silent.
    const runner: CodexRunner = async function* () {
        yield { type: "item.completed", item: { id: "e1", type: "error", message: ADVISORY } } as ThreadEvent;
        throw new Error("Codex Exec exited with code 1: Reading prompt from stdin...");
    };
    expect(await collect(createCodexAgent("/home", runner), request)).toEqual([
        { kind: "error", code: "codex-advisory", message: ADVISORY },
        { kind: "error", message: "Codex Exec exited with code 1: Reading prompt from stdin..." },
        { kind: "done" },
    ]);
});

test("turn failures and thrown runners become error events followed by done", async () => {
    const failing = fakeRunner([{ type: "turn.failed", error: { message: "usage limit reached" } }]);
    expect(await collect(createCodexAgent("/home", failing.runner), request)).toEqual([
        { kind: "error", message: "usage limit reached" },
        { kind: "done" },
    ]);

    const throwing: CodexRunner = async function* () {
        yield { type: "thread.started", thread_id: "thr-4" } as ThreadEvent;
        throw new Error("codex exec blew up");
    };
    expect(await collect(createCodexAgent("/home", throwing), request)).toEqual([
        { kind: "session", sessionId: "thr-4" },
        { kind: "error", message: "codex exec blew up" },
        { kind: "done" },
    ]);
});

test("a streamed error survives the SDK's non-zero-exit throw", async () => {
    // Codex streams the real cause (e.g. out of credits), then exits non-zero — which makes the SDK throw its
    // generic "Codex Exec exited with code 1: Reading prompt from stdin..." wrapper. The wrapper must not
    // overwrite the actionable message already surfaced.
    const runner: CodexRunner = async function* () {
        yield { type: "thread.started", thread_id: "thr-5" } as ThreadEvent;
        yield { type: "turn.failed", error: { message: "Your workspace is out of credits." } } as ThreadEvent;
        throw new Error("Codex Exec exited with code 1: Reading prompt from stdin...");
    };
    expect(await collect(createCodexAgent("/home", runner), request)).toEqual([
        { kind: "session", sessionId: "thr-5" },
        { kind: "error", message: "Your workspace is out of credits." },
        { kind: "done" },
    ]);
});
