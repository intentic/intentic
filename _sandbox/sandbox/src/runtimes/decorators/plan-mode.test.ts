import { type AgentEvent, CLAUDE_CODE, CODEX, type PermissionMode } from "@intentic/sandbox-contract";
import { test, expect } from "bun:test";
import type { AgentRequest } from "../../agent/providers/agent-request.js";
import { type EmulatedPlan, EXECUTE_PROMPT, type PlanPhaseResult, planMode } from "./plan-mode.js";
import { parkedCards } from "../../agents/actor/parked-cards.js";
import { memoryFleet } from "../../testing.js";

// Where a turn here parks its plan card: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

/* Which runtimes plan through the emulation, and what the emulation shows and runs, driven by a scripted runtime. */

const request = (
    permissionMode: PermissionMode | undefined,
    signal: AbortSignal = new AbortController().signal,
): Pick<AgentRequest, "spec" | "policy" | "signal" | "hooks"> => ({
    spec: { prompt: "tidy the parser", cwd: "/w", sessionId: "s-0" },
    policy: permissionMode === undefined ? {} : { permissionMode },
    hooks: { cards },
    signal,
});

// A runtime that records every phase it is asked to run and plans the scripted results in order.
const scripted = (plans: readonly PlanPhaseResult[]) => {
    const phases: string[] = [];
    let next = 0;
    const emulated: EmulatedPlan = {
        prompt: "PLAN FIRST: tidy the parser",
        async *plan(prompt, sessionId) {
            phases.push(`plan ${sessionId ?? "-"}: ${prompt}`);
            yield { kind: "thinking", text: "reading" };
            const result = plans[next] ?? plans.at(-1)!;
            next += 1;
            return result;
        },
        async *execute(sessionId) {
            phases.push(`execute ${sessionId ?? "-"}`);
            yield { kind: "delta", text: "done" };
        },
    };
    const direct = async function* (): AsyncGenerator<AgentEvent> {
        phases.push("direct");
        yield { kind: "delta", text: "ran" };
    };
    return { phases, emulated, direct };
};

// Drains a turn, answering each plan card with the next scripted decision once the turn is waiting on it: the card is
// only listened for after its frame has gone out.
const run = async (turn: AsyncGenerator<AgentEvent>, decisions: readonly { approve: boolean; feedback?: string }[] = []): Promise<AgentEvent[]> => {
    const frames: AgentEvent[] = [];
    let answered = 0;
    for await (const frame of turn) {
        frames.push(frame);
        if (frame.kind === "plan") {
            const decision = decisions[answered]!;
            answered += 1;
            setTimeout(() => cards.resolve({ kind: "plan", requestId: frame.requestId, ...decision }), 0);
        }
    }
    return frames;
};

const planned = (text: string, sessionId = "s-9"): PlanPhaseResult => ({ sessionId, planText: text, errored: false });

test("a runtime whose row holds approval modes plans on its own: the emulation is never built", async () => {
    const runtime = scripted([planned("1. edit")]);
    let built = false;
    const frames = await run(
        planMode(
            CLAUDE_CODE,
            request("plan"),
            () => {
                built = true;
                return runtime.emulated;
            },
            runtime.direct,
        ),
    );

    expect(built).toBe(false);
    expect(runtime.phases).toEqual(["direct"]);
    expect(frames).toEqual([{ kind: "delta", text: "ran" }]);
});

test("a turn not asked to plan runs once, as it is, on a runtime that lacks the modes", async () => {
    for (const mode of [undefined, "bypassPermissions", "default"] as const) {
        const runtime = scripted([planned("1. edit")]);
        const frames = await run(planMode(CODEX, request(mode), () => runtime.emulated, runtime.direct));

        expect(runtime.phases, String(mode)).toEqual(["direct"]);
        expect(frames, String(mode)).toEqual([{ kind: "delta", text: "ran" }]);
    }
});

test("asked to plan, the plan phase's text is the card, and approval executes on the session the plan ran in", async () => {
    const runtime = scripted([planned("1. split the lexer")]);
    const frames = await run(
        planMode(CODEX, request("plan"), () => runtime.emulated, runtime.direct),
        [{ approve: true }],
    );

    expect(runtime.phases).toEqual(["plan s-0: PLAN FIRST: tidy the parser", "execute s-9"]);
    expect(frames).toEqual([
        { kind: "thinking", text: "reading" },
        { kind: "plan", requestId: expect.any(String), text: "1. split the lexer" },
        { kind: "resolved", requestId: expect.any(String), reply: { kind: "plan", requestId: expect.any(String), approve: true } },
        { kind: "delta", text: "done" },
    ]);
});

test("a rejection plans again, told what the user said, or told only that the plan was rejected", async () => {
    const runtime = scripted([planned("1. rewrite everything"), planned("1. rename one function"), planned("1. rename it")]);
    await run(
        planMode(CODEX, request("plan"), () => runtime.emulated, runtime.direct),
        [{ approve: false, feedback: "  smaller, please  " }, { approve: false, feedback: "   " }, { approve: true }],
    );

    expect(runtime.phases).toEqual([
        "plan s-0: PLAN FIRST: tidy the parser",
        "plan s-9: The user rejected the plan with this feedback:\nsmaller, please\n\nRevise the plan. Still do not execute it.",
        "plan s-9: The user rejected the plan. Revise it. Still do not execute it.",
        "execute s-9",
    ]);
});

test("a phase that reports no session keeps the one the turn resumed", async () => {
    const runtime = scripted([{ sessionId: undefined, planText: "1. edit", errored: false }]);
    await run(
        planMode(CODEX, request("plan"), () => runtime.emulated, runtime.direct),
        [{ approve: true }],
    );

    expect(runtime.phases).toEqual(["plan s-0: PLAN FIRST: tidy the parser", "execute s-0"]);
});

test("a planning phase that errored, or proposed nothing, shows no card and runs nothing after it", async () => {
    for (const result of [
        { sessionId: "s-9", planText: "1. half a plan", errored: true },
        { sessionId: "s-9", planText: undefined, errored: false },
        { sessionId: "s-9", planText: "  \n ", errored: false },
    ]) {
        const runtime = scripted([result]);
        const frames = await run(planMode(CODEX, request("plan"), () => runtime.emulated, runtime.direct));

        expect(runtime.phases, JSON.stringify(result)).toEqual(["plan s-0: PLAN FIRST: tidy the parser"]);
        expect(frames, JSON.stringify(result)).toEqual([{ kind: "thinking", text: "reading" }]);
    }
});

test("a turn stopped while planning shows no card", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = scripted([planned("1. edit")]);
    const frames = await run(planMode(CODEX, request("plan", controller.signal), () => runtime.emulated, runtime.direct));

    expect(frames).toEqual([{ kind: "thinking", text: "reading" }]);
    expect(runtime.phases).toEqual(["plan s-0: PLAN FIRST: tidy the parser"]);
});

test("the execute phase is told the plan is approved, in so many words", () => {
    expect(EXECUTE_PROMPT).toBe("The plan is approved: execute it now.");
});
