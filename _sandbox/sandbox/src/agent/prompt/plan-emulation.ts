import type { AgentEvent } from "@intentic/sandbox-contract";
import { createRequest } from "../tools/agent-requests.js";

// Always-plan flow for backends without a native ExitPlanMode hook (codex, grok, acp): a read-only planning turn
// becomes the `plan` frame, then, once approved, an execution turn resumes the same session; rejection loops another
// planning turn. The skeleton owns the loop and gates; each backend supplies how a phase runs.

export const PLAN_PREAMBLE =
    "Before making any changes, propose a clear, concise plan for the request below and stop: do not execute it yet. End your reply with the plan itself.\n\n";

export const EXECUTE_PROMPT = "The plan is approved: execute it now.";

// What one planning phase captured: the session to resume, the proposed plan text, and whether it errored (already
// streamed, so no plan is proposed from partial output).
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
            // Already streamed its own error frame; do not propose a plan built from partial output.
            return;
        }
        const { id, wait } = createRequest("plan", { kind: "plan", requestId: "", approve: false, feedback: "Planning cancelled." });
        yield { kind: "plan", requestId: id, text: capture.planText };
        const { reply: decision, resolved } = await wait(signal);
        // Freezes the plan card in every transcript, including a replay with no record it went stale.
        yield resolved;
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
