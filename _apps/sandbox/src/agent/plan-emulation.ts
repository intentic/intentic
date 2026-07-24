import type { AgentEvent } from "@intentic/sandbox-contract";
import { createRequest } from "./agent-requests.js";

/* The always-plan flow for backends without a native ExitPlanMode hook (codex, grok, acp), emulated in two
 * phases: a read-only planning turn whose captured text becomes the `plan` frame, then — once approved on the
 * shared decision bridge — an execution turn resumed on the same session. Rejection feedback loops another
 * planning turn. The skeleton owns the loop, the gates, and the revision prompts; each backend supplies how a
 * phase actually runs (its runner, sandbox modes, capture mechanics). */

export const PLAN_PREAMBLE =
    "Before making any changes, propose a clear, concise plan for the request below and stop — do not execute it yet. End your reply with the plan itself.\n\n";

export const EXECUTE_PROMPT = "The plan is approved — execute it now.";

// What one planning phase captured: the session to resume for the next phase, the proposed plan text, and
// whether the phase errored (an error frame already streamed, so no plan may be proposed from partial output).
export interface PlanPhaseResult {
    readonly sessionId: string | undefined;
    readonly planText: string | undefined;
    readonly errored: boolean;
}

export type PlanPhase = (prompt: string, sessionId: string | undefined) => AsyncGenerator<AgentEvent, PlanPhaseResult>;
export type ExecutePhase = (sessionId: string | undefined) => AsyncGenerator<AgentEvent>;

export async function* runPlanEmulation(
    signal: AbortSignal,
    initialPrompt: string,
    seedSessionId: string | undefined,
    planPhase: PlanPhase,
    executePhase: ExecutePhase,
): AsyncGenerator<AgentEvent> {
    let prompt = initialPrompt;
    let sessionId = seedSessionId;
    for (;;) {
        const capture = yield* planPhase(prompt, sessionId);
        sessionId = capture.sessionId ?? sessionId;
        if (capture.errored || capture.planText === undefined || capture.planText.trim() === "" || signal.aborted) {
            // The planning turn errored/aborted (or produced no plan text) — the error frame already streamed,
            // so don't propose a plan built from partial output.
            return;
        }
        const { id, wait } = createRequest("plan", { kind: "plan", requestId: "", approve: false, feedback: "Planning cancelled." });
        yield { kind: "plan", requestId: id, text: capture.planText };
        const decision = await wait(signal);
        if (signal.aborted) {
            return;
        }
        if (!decision.approve) {
            const feedback = decision.feedback?.trim();
            prompt =
                feedback !== undefined && feedback !== ""
                    ? `The user rejected the plan with this feedback:\n${feedback}\n\nRevise the plan. Still do not execute it.`
                    : "The user rejected the plan. Revise it. Still do not execute it.";
            continue;
        }
        yield* executePhase(sessionId);
        return;
    }
}
