import type { AgentCapabilities, AgentEvent } from "@intentic/sandbox-contract";
import type { AgentRequest } from "../../agent/providers/agent-request.js";

// Plan mode for a runtime whose capability row holds no approval modes (`permissions: "plan"`): a read-only planning
// phase becomes the `plan` card, then, once approved, an executing phase resumes the same session; a rejection loops
// another planning phase. This owns the loop and the card; each runtime supplies how one phase runs.

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
export type ExecutePhase = (sessionId: string | undefined) => AsyncGenerator<AgentEvent, unknown>;

// How a runtime runs each half of an emulated plan, and the planning phase's first message.
export interface EmulatedPlan {
    readonly prompt: string;
    readonly plan: PlanPhase;
    readonly execute: ExecutePhase;
}

// The plan a phase proposed, or undefined when it errored, proposed nothing, or the turn was stopped: its own frames
// already said why, and no plan is proposed from partial output.
const proposed = (capture: PlanPhaseResult, signal: AbortSignal): string | undefined =>
    capture.errored || capture.planText === undefined || capture.planText.trim() === "" || signal.aborted ? undefined : capture.planText;

// The next planning message after a rejection, carrying what the user said when they said anything.
const revision = (feedback: string | undefined): string => {
    const said = feedback?.trim();
    return said !== undefined && said !== ""
        ? `The user rejected the plan with this feedback:\n${said}\n\nRevise the plan. Still do not execute it.`
        : "The user rejected the plan. Revise it. Still do not execute it.";
};

async function* emulate(request: Pick<AgentRequest, "spec" | "signal" | "hooks">, emulated: EmulatedPlan): AsyncGenerator<AgentEvent> {
    const { signal } = request;
    let prompt = emulated.prompt;
    let sessionId = request.spec.sessionId;
    for (;;) {
        const capture = yield* emulated.plan(prompt, sessionId);
        sessionId = capture.sessionId ?? sessionId;
        const plan = proposed(capture, signal);
        if (plan === undefined) {
            return;
        }
        const { id, wait } = request.hooks.cards.create("plan", { kind: "plan", requestId: "", approve: false, feedback: "Planning cancelled." });
        yield { kind: "plan", requestId: id, text: plan };
        const { reply: decision, resolved } = await wait(signal);
        // Freezes the plan card in every transcript, including a replay with no record it went stale.
        yield resolved;
        if (signal.aborted) {
            return;
        }
        if (decision.approve) {
            yield* emulated.execute(sessionId);
            return;
        }
        prompt = revision(decision.feedback);
    }
}

// A turn on `capabilities`' runtime: the emulated plan when the turn asked to plan and the row says the runtime cannot on
// its own, else its one ordinary run. `emulated` is built only when it runs, since its phases hold per-turn state.
export async function* planMode(
    capabilities: Pick<AgentCapabilities, "permissions">,
    request: Pick<AgentRequest, "spec" | "policy" | "signal" | "hooks">,
    emulated: () => EmulatedPlan,
    direct: () => AsyncGenerator<AgentEvent, unknown>,
): AsyncGenerator<AgentEvent> {
    if (capabilities.permissions === "modes" || request.policy.permissionMode !== "plan") {
        yield* direct();
        return;
    }
    yield* emulate(request, emulated());
}
