import type { AgentCapabilities, PersonaPowers } from "@intentic/sandbox-contract";
import type { ConversationActors } from "./conversation-actors.js";
import type { Holding } from "./conversation-holdings.js";

// What a conversation's current turn was decided with, recorded as planning settles it (agent/run/turn/turn-plan.ts),
// so a route the turn's own CLIs call can answer for THIS turn rather than for the sandbox. "GitHub is connected" is
// true of the sandbox and still wrong for a turn whose persona leaves GitHub out, whose gate holds it for an approver,
// or which nobody is watching: those three answers were each once given as "use it" (docs/architecture/needs.md).

export interface TurnStanding {
    // When planning settled it; a newer turn replaces it.
    readonly at: number;
    // Nobody at a composer: no card is answered while the turn runs, so an ask must not hold it.
    readonly unattended: boolean;
    // The persona the turn wears, when it wears one.
    readonly persona: { readonly id: string; readonly name: string } | undefined;
    // Capability ids this turn mounted: after the persona's shelves and the owner's gates.
    readonly granted: readonly string[];
    // Connected capability ids the persona leaves out of this turn.
    readonly withheldByPersona: readonly string[];
    // Connected capability ids a gate holds for a named approver.
    readonly withheldByGate: readonly string[];
    // The folders this turn's file tools may touch; undefined is the whole workspace.
    readonly fence: readonly string[] | undefined;
    // The shelves open to it, fully resolved.
    readonly powers: PersonaPowers;
    // Which runtime serves it, and whether that runtime resolves `{{secret:NAME}}` references at execution.
    readonly runtime: AgentCapabilities["runtime"];
    readonly secrets: AgentCapabilities["secrets"];
}

type Actors = Pick<ConversationActors, "holdings">;

// One per conversation, under the conversation's own id: the newest turn replaces the last.
const TURN_STANDING: Holding<TurnStanding> = { name: "turn standing" };

export const recordTurnStanding = (actors: Actors, conversationId: string, standing: TurnStanding): void => {
    actors.holdings(TURN_STANDING).hold(conversationId, conversationId, standing);
};

/** The standing of the conversation's latest planned turn, or undefined for one this daemon has not planned. */
export const turnStandingOf = (actors: Actors, conversationId: string): TurnStanding | undefined => actors.holdings(TURN_STANDING).get(conversationId);
