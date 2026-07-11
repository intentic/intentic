import { randomUUID } from "node:crypto";

/* In-memory bridges that let an in-flight agent turn pause and wait for the user. When the model
 * calls ExitPlanMode we surface the plan and block until the user approves/rejects; when it asks
 * interactive questions we block until the user answers. Decisions/answers arrive on separate
 * `POST /agent/decision` / `POST /agent/answer` requests and resolve the paused promise here.
 *
 * The daemon is single-tenant (one container per project, reached only over its authenticated tunnel — the
 * owner's Google ID token), so requests are keyed by an unguessable id alone — no per-user scoping. */

export interface PlanDecision {
    readonly approve: boolean;
    readonly feedback?: string;
}

export interface QuestionResponse {
    // Map of question text → selected option label(s) (+ any free-text "Other" answer).
    readonly answers?: Record<string, string[]>;
    // Set when the user dismissed the card or the turn was aborted before answering.
    readonly cancelled?: boolean;
}

const pendingPlans = new Map<string, (decision: PlanDecision) => void>();
const pendingQuestions = new Map<string, (response: QuestionResponse) => void>();

// Register a pending plan approval; resolves on the user's decision, or denies on abort (Stop).
export function createPlanRequest(): { id: string; wait: (signal: AbortSignal) => Promise<PlanDecision> } {
    const id = randomUUID();
    const wait = (signal: AbortSignal): Promise<PlanDecision> =>
        new Promise<PlanDecision>((resolve) => {
            const settle = (decision: PlanDecision): void => {
                if (pendingPlans.delete(id)) {
                    resolve(decision);
                }
            };
            if (signal.aborted) {
                settle({ approve: false, feedback: "Planning cancelled." });
                return;
            }
            pendingPlans.set(id, settle);
            signal.addEventListener("abort", () => settle({ approve: false, feedback: "Planning cancelled." }), { once: true });
        });
    return { id, wait };
}

export function resolvePlanDecision(id: string, decision: PlanDecision): boolean {
    const settle = pendingPlans.get(id);
    if (settle === undefined) {
        return false;
    }
    settle(decision);
    return true;
}

// Register a pending question; resolves on the user's answer, or cancels on abort (Stop).
export function createQuestionRequest(): { id: string; wait: (signal: AbortSignal) => Promise<QuestionResponse> } {
    const id = randomUUID();
    const wait = (signal: AbortSignal): Promise<QuestionResponse> =>
        new Promise<QuestionResponse>((resolve) => {
            const settle = (response: QuestionResponse): void => {
                if (pendingQuestions.delete(id)) {
                    resolve(response);
                }
            };
            if (signal.aborted) {
                settle({ cancelled: true });
                return;
            }
            pendingQuestions.set(id, settle);
            signal.addEventListener("abort", () => settle({ cancelled: true }), { once: true });
        });
    return { id, wait };
}

export function resolveQuestionAnswer(id: string, response: QuestionResponse): boolean {
    const settle = pendingQuestions.get(id);
    if (settle === undefined) {
        return false;
    }
    settle(response);
    return true;
}
