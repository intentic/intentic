import { errorMessage } from "@intentic/base/errors";
import type { ExtensionCaller } from "@intentic/extension-api";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { type FixAttemptPlan, type FixResume, planFixAttempt } from "@intentic/sandbox-contract/state/fix-attempt-plan";
import type { AgentRun, PipelinesDaemon } from "./daemon.js";

/* ONE FAILURE, MANY ATTEMPTS, ONE LIVE ANSWER — for a fix this extension starts: a failed CI run (POST fix, the board's
   Fix press, and main's one fix agent in main-fixer.ts). The plan is the contract's (state/fix-attempt-plan.ts), which the
   board reads too; the attempts are conversations the daemon runs, started through POST /agent. (2026-11-26) The
   daemon's conversations/fix/fix-attempts.ts until main's fix agent moved here. */

// The longest title a conversation keeps (the daemon's TITLE_MAX); a longer one is cut where the board would cut it.
const TITLE_MAX = 80;

export interface FixAttemptDeps {
    // The live roster and the archive as the registry holds them now; both count toward the next attempt's number.
    readonly roster: () => Promise<readonly AgentSummary[]>;
    readonly archivedIds: () => Promise<readonly string[]>;
    // Hard-stops a running turn: the archive refuses a conversation still running, unless it was stopped.
    readonly stop: (conversationId: string) => Promise<void>;
    // Files the attempt away, branch and transcript intact; throws with the registry's reason when it will not.
    readonly archive: (conversationId: string) => Promise<void>;
    // Says the turn into the conversation; false means a live turn already owned it, so its words went into that turn.
    readonly start: (turn: AgentRun & { readonly conversationId: string }) => Promise<boolean>;
}

export interface FixAttemptAsk {
    // The failure's derived id, which attempt 1 wears.
    readonly base: string;
    // The opening prompt a fresh attempt gets, and the shorter nudge a continued one gets.
    readonly prompt: string;
    readonly nudge: string;
    // A fresh attempt's title; a later attempt has its number appended, a continued one keeps the title it has.
    readonly title: string;
    // What every attempt's turn carries besides its words: isolation, the job, the caret's pick, a booking.
    readonly turn: Omit<AgentRun, "prompt" | "conversationId" | "title">;
    // The verb the picker's bar was ended with; absent is the plain press.
    readonly resume?: FixResume | undefined;
}

export type FixAttemptOutcome =
    | { readonly kind: "started"; readonly conversationId: string; readonly attempt: number; readonly continued: boolean }
    // The latest attempt is still in play, or a turn took the conversation between the plan and the start.
    | { readonly kind: "busy"; readonly conversationId: string; readonly reason: string };

type StartingPlan = Exclude<FixAttemptPlan, { readonly kind: "busy" }>;

// What an attempt's turn says: a continued one the nudge under the title it has, one turned away the whole prompt under
// the title it has, since it never saw a word of it; a fresh one the whole prompt under a title numbered past attempt 1.
const openingOf = (plan: StartingPlan, ask: FixAttemptAsk): Pick<AgentRun, "prompt" | "title"> => {
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
    const roster = await deps.roster();
    const plan = planFixAttempt(ask.base, roster, [...roster.map((agent) => agent.id), ...(await deps.archivedIds())], ask.resume);
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
    // An attempt turned away at the door gets the whole prompt again: the ask carries the failure as it stands now, which
    // may have grown since that turn was first sent.
    const started = await deps.start({ ...ask.turn, ...openingOf(plan, ask), conversationId: plan.conversationId });
    if (!started) {
        return { kind: "busy", conversationId: plan.conversationId, reason: "An agent is already working on this run's failure." };
    }
    return { kind: "started", conversationId: plan.conversationId, attempt: plan.attempt, continued };
};

// The earlier attempt would not be filed away, or the daemon refused the start; carries its reason.
export class AttemptRefused extends Error {}

/** How this extension's fix attempts reach the daemon: as the extension itself (main's fix agent starting by itself), or
 *  as whoever pressed Fix (`as`, the caller the daemon vouched for), who then owns the conversation it opens. POST /agent
 *  reopens an archived conversation it is said into, as a person's message would. */
export const extensionFixAttemptDeps = (daemon: PipelinesDaemon, as?: ExtensionCaller): FixAttemptDeps => ({
    roster: () => daemon.roster(),
    archivedIds: () => daemon.archivedIds(),
    // Whatever runs on the earlier attempt goes: it is being set aside, whichever turn it is on.
    stop: (conversationId) => daemon.stop(conversationId),
    archive: async (conversationId) => {
        const refused = await daemon.archive(conversationId);
        if (refused !== undefined) {
            throw new AttemptRefused(`The earlier attempt could not be set aside: ${refused}`);
        }
    },
    start: async (turn) => {
        try {
            return (await daemon.say(turn, as)).delivered !== "steered";
        } catch (error) {
            throw new AttemptRefused(errorMessage(error));
        }
    },
});
