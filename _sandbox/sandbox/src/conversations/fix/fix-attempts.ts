import { type AgentSummary, type AgentTurn, type FixAttemptPlan, type FixResume, planFixAttempt } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { TurnInput } from "../../seams/turn-starter.js";
import { archiveAgents } from "../registry/archive.js";

/* ONE FAILURE, MANY ATTEMPTS, ONE LIVE ANSWER — the daemon's side of it, for a fix the daemon itself starts: a red CI
   run (ci/ci-fix.ts, POST /ci/fix and the repair gate) or a red main-line check after a land (conversations/land/land-fix.ts). */

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

const reopened = async (services: Services, pressed: boolean, conversationId: string): Promise<void> => {
    if (pressed) {
        await services.agents.clearArchived([conversationId]);
    }
};

// The earlier attempt would not be filed away, so no new one was started; carries the registry's reason.
export class AttemptRefused extends Error {}

// How the daemon's own fix attempts reach the fleet, for every failure it starts one on: a failed CI run here, a red
// main-line check in conversations/land/land-fix.ts.
// `pressed`: somebody pressed for this attempt, the door a person's words come through, so an archived conversation it
// continues reopens first (clearArchived) exactly as a person's message would reopen it.
export const daemonFixAttemptDeps = (services: Services, request: { readonly pressed: boolean; readonly picked: boolean }): FixAttemptDeps => ({
    roster: () => services.agents.list(),
    archivedIds: () => services.agents.listArchived().map((agent) => agent.id),
    // Whatever runs on the earlier attempt goes: it is being set aside, whichever turn it is on.
    stop: async (conversationId) => {
        await services.turns.stop({ conversationId, live: true });
    },
    archive: async (conversationId) => {
        const { failed } = await archiveAgents(services, [conversationId], Date.now());
        const refused = failed[0];
        if (refused !== undefined) {
            throw new AttemptRefused(`The earlier attempt could not be set aside: ${refused.reason}`);
        }
    },
    // Same detached-run boundary as POST /agent, so the run map, journal, transcript and observer stay wired; no composer
    // holds these words, so a refusal at the door leaves the sandbox keeping the turn.
    start: async (turn) => {
        if (request.pressed) {
            await services.agents.clearArchived([turn.conversationId]);
        }
        const started = await services.turns.start(turn);
        return typeof started === "string" ? undefined : started;
    },
    // A pick is a choice made now, so it outranks the kept turn's routing: the whole prompt goes on it.
    rerun: async (conversationId) =>
        !request.picked && services.conversations.state(conversationId)?.resume.held?.reason === "door"
            ? reopened(services, request.pressed, conversationId).then(() => services.turns.resume(conversationId))
            : undefined,
});
