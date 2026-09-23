import { type AgentSummary, type AgentTurn, type FixAttemptPlan, type FixResume, planFixAttempt } from "@intentic/sandbox-contract";
import type { TurnInput } from "../seams/turn-starter.js";

/* ONE FAILURE, MANY ATTEMPTS, ONE LIVE ANSWER — the daemon's side of it, for a fix the daemon itself starts (POST /ci/fix). */

export interface FixAttemptDeps {
    // The live roster and the archive as the registry holds them now; both count toward the next attempt's number.
    readonly roster: () => readonly AgentSummary[];
    readonly archivedIds: () => readonly string[];
    // Hard-stops a running turn and waits for it to unwind: the archive refuses a conversation still running.
    readonly stop: (conversationId: string) => Promise<void>;
    // Files the attempt away, branch and transcript intact; throws with the registry's reason when it will not.
    readonly archive: (conversationId: string) => Promise<void>;
    // Starts the turn; undefined means a live turn already owns the conversation.
    readonly start: (turn: TurnInput & { conversationId: string }) => Promise<unknown>;
    // Runs again the turn the sandbox kept after turning it away at the door; undefined when it keeps none there.
    readonly rerun: (conversationId: string) => Promise<unknown>;
}

export interface FixAttemptAsk {
    // The failure's derived id, which attempt 1 wears.
    readonly base: string;
    // The opening prompt a fresh attempt gets, and the shorter nudge a continued one gets.
    readonly prompt: string;
    readonly nudge: string;
    // A fresh attempt's title; a later attempt has its number appended, a continued one keeps the title it has.
    readonly title: string;
    // What every attempt's turn carries besides its words: isolation, origin, the caret's pick, who pressed.
    readonly turn: Omit<TurnInput, "prompt" | "conversationId" | "title">;
    // The verb the picker's bar was ended with; absent is the plain press.
    readonly resume?: FixResume | undefined;
}

export type FixAttemptOutcome =
    | { readonly kind: "started"; readonly conversationId: string; readonly attempt: number; readonly continued: boolean }
    // The latest attempt is still in play, or a turn took the conversation between the plan and the start.
    | { readonly kind: "busy"; readonly conversationId: string; readonly reason: string };

// The registry's own cap on a title, so an appended attempt number never pushes one past it.
const TITLE_MAX = 80;

type StartingPlan = Exclude<FixAttemptPlan, { readonly kind: "busy" }>;

// What an attempt's turn says: a continued one the nudge under the title it has, one turned away the whole prompt under
// the title it has, since it never saw a word of it; a fresh one the whole prompt under a title numbered past attempt 1.
const openingOf = (plan: StartingPlan, ask: FixAttemptAsk): Pick<AgentTurn, "prompt" | "title"> => {
    if (plan.kind === "continue") {
        return { prompt: ask.nudge };
    }
    if (plan.kind === "resend") {
        return { prompt: ask.prompt };
    }
    const title = plan.attempt > 1 ? `${ask.title} (attempt ${plan.attempt})` : ask.title;
    return { prompt: ask.prompt, title: title.slice(0, TITLE_MAX) };
};

export const startFixAttempt = async (deps: FixAttemptDeps, ask: FixAttemptAsk): Promise<FixAttemptOutcome> => {
    const roster = deps.roster();
    const plan = planFixAttempt(ask.base, roster, [...roster.map((agent) => agent.id), ...deps.archivedIds()], ask.resume);
    if (plan.kind === "busy") {
        return { kind: "busy", conversationId: plan.conversationId, reason: plan.stance.hint };
    }
    if (plan.kind === "start-over") {
        if (plan.stopFirst) {
            await deps.stop(plan.retire);
        }
        await deps.archive(plan.retire);
    }
    const continued = plan.kind === "continue" || plan.kind === "resend";
    // The kept turn is the task exactly as first sent, routing and all; the prompt goes again only where none is kept.
    const started =
        (plan.kind === "resend" ? await deps.rerun(plan.conversationId) : undefined) ??
        (await deps.start({ ...ask.turn, ...openingOf(plan, ask), conversationId: plan.conversationId }));
    if (started === undefined) {
        return { kind: "busy", conversationId: plan.conversationId, reason: "An agent is already working on this run's failure." };
    }
    return { kind: "started", conversationId: plan.conversationId, attempt: plan.attempt, continued };
};
