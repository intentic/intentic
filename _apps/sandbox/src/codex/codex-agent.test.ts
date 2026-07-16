import type { ThreadEvent } from "@openai/codex-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { resolvePlanDecision } from "../agent/agent-requests.js";
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
    onPlan?: (decisionId: string) => { approve: boolean; feedback?: string },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent(turnRequest)) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan(event.decisionId);
            setTimeout(() => resolvePlanDecision(event.decisionId, decision), 0);
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
        { kind: "tool", id: "c1", name: "Bash", target: "pnpm test" },
        { kind: "tool_result", id: "c1", output: "1 passed" },
        { kind: "tool", id: "f1", name: "Edit", target: "update src/app.ts" },
        { kind: "todos", items: [{ content: "add route", status: "pending" }] },
        { kind: "delta", text: "Added the route." },
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

test("a failed command surfaces its output as an error tool result", async () => {
    const { runner } = fakeRunner([
        {
            type: "item.completed",
            item: { id: "c1", type: "command_execution", command: "pnpm test", aggregated_output: "1 failed", exit_code: 1, status: "failed" },
        },
    ]);
    const events = await collect(createCodexAgent("/home", runner), request);
    expect(events).toEqual([{ kind: "tool_result", id: "c1", output: "1 failed", isError: true }, { kind: "done" }]);
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
    await collect(createCodexAgent("/home", runner), { ...request, plan: true, attachments: ["/work/a/shot.png"] }, () => ({ approve: true }));
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
    const events = await collect(createCodexAgent("/home", runner), { ...request, plan: true }, () => ({ approve: true }));

    expect(events).toEqual([
        { kind: "session", sessionId: "thr-2" },
        { kind: "plan", decisionId: expect.any(String) as string, text: "Plan: add the route, then test." },
        { kind: "delta", text: "Done." },
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
    const events = await collect(createCodexAgent("/home", runner), { ...request, plan: true }, () => {
        planCount += 1;
        return planCount === 1 ? { approve: false, feedback: "use fastify" } : { approve: true };
    });

    expect(events.filter((event) => event.kind === "plan").map((event) => (event as { text: string }).text)).toEqual(["Plan v1", "Plan v2"]);
    expect(events.at(-2)).toEqual({ kind: "delta", text: "Executed." });
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
    const events = await collect(createCodexAgent("/home", runner), { ...request, plan: true });
    expect(events).toEqual([
        { kind: "session", sessionId: "thr-7" },
        { kind: "error", message: "Payment Required" },
        { kind: "done" },
    ]);
    expect(events.some((event) => event.kind === "plan")).toBe(false);
    expect(calls).toHaveLength(1);
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
