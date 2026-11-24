import type { ConversationActors } from "./conversation-actors.js";
import type { Holding } from "./conversation-holdings.js";
import type { DomainEventMap } from "../../seams/domain-events.js";

/* A CANCELLED CONVERSATION STAYS STOPPED UNTIL SOMEBODY SPEAKS TO IT. A cancel stopped the turn and nothing else: the
   turn's own close handed the background jobs it left running to watches (turn-close.ts), and each exit woke the
   conversation into a turn of its own. On 2026-11-24 an orchestrator in shinobi-society cancelled six slices on its
   owner's "stop all subagents"; the slices' own subagents were each woken again by a build or a bench they had left
   running, one of them three times, and the last ran a full 19-minute turn whose work then went up two checkouts into
   the orchestrator's branch. A cancel now marks the conversation halted (agent/subagents/family/child-cancel.ts, family-stop.ts): while the mark
   stands, nothing the sandbox sends starts a turn on it (turn-admission.ts), no re-run it booked fires (turn-resume.ts),
   its turn's close stops what it left running instead of waiting on it (turn-close.ts), and a land its last close held
   for a wake does not run (wake-held-land.ts). Words from a person or an agent lift it: whoever writes to it means it
   to work again. Held in memory: what the sandbox could wake it with later (its watches, its jobs, its booked re-run,
   its queued words) is taken off the record as the cancel runs (agent/subagents/family/halt-quiet.ts), so a restart finds nothing to wake. Kept here, beside the
   conversation's other holdings, since admission and the land read it too. */

/** Who stopped it: an agent above it (its parent, or an ancestor), or a person's Stop all. */
export type HaltedBy = "agent" | "person";

export interface Halt {
    readonly at: number;
    readonly by: HaltedBy;
}

const HALTED: Holding<Halt> = { name: "halted by a cancel" };

type Actors = Pick<ConversationActors, "holdings">;

/** Marks a conversation as stopped by a cancel, before its turn is stopped, so the turn's own close already reads it. */
export const haltConversation = (actors: Actors, conversationId: string, by: HaltedBy, now: number = Date.now()): void => {
    actors.holdings(HALTED).hold(conversationId, conversationId, { at: now, by });
};

/** The cancel a conversation still stands stopped by, if any. */
export const haltOf = (actors: Actors, conversationId: string): Halt | undefined => actors.holdings(HALTED).get(conversationId);

/** Lifts the mark, as words from a person or an agent do; answers whether there was one. */
export const liftHalt = (actors: Actors, conversationId: string): boolean => actors.holdings(HALTED).drop(conversationId);

/**
 * Lifts the mark as a turn starts on words somebody wrote to it: a person's, a program's or an agent's, or a person's
 * Continue. A re-run the sandbox sent by itself carries its first sender as its speaker, so a turn naming any other
 * resume reason lifts nothing; neither does the sandbox's own wake. Runs on every run.started (agent/subagents/children.ts adoptChildTurn),
 * before a cancelled child's stray turn is stopped (adoptRun).
 */
export const liftHaltOnStart = (actors: Actors, started: Pick<DomainEventMap["run.started"], "conversationId" | "speaker" | "resume">): void => {
    const kind = started.speaker?.kind;
    const written = kind !== undefined && kind !== "sandbox" && started.resume === undefined;
    if (written || (kind === "person" && started.resume === "continued")) {
        liftHalt(actors, started.conversationId);
    }
};

/** Why the sandbox's own words reach no halted conversation, as the admission door answers them. */
export const HALTED_WORDS = "the conversation was stopped by a cancel, and only a message from a person or an agent starts it again";
