import type { AgentCapabilities } from "@intentic/sandbox-contract/models/agent-runtimes";
import type { RolePowers } from "@intentic/sandbox-contract/schemas/roles";
import type { ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import type { ConversationActors } from "./conversation-actors.js";
import type { Holding } from "./conversation-holdings.js";

// What a conversation's current turn was decided with, recorded as planning settles it (agent/run/turn/turn-plan.ts),
// so a route the turn's own CLIs call can answer for THIS turn rather than for the sandbox. "GitHub is connected" is
// true of the sandbox and still wrong for a turn whose role leaves GitHub out, whose gate holds it for an approver,
// or which nobody is watching: those three answers were each once given as "use it" (docs/architecture/needs.md).

export interface TurnStanding {
    // When planning settled it; a newer turn replaces it.
    readonly at: number;
    // Nobody at a composer: no card is answered while the turn runs, so an ask must not hold it.
    readonly unattended: boolean;
    // Who the turn acts as: its card, or the built-in it wears (Full access, No accounts). Absent for an unknown name.
    readonly role: { readonly id: string; readonly name: string } | undefined;
    // Capability ids this turn mounted: after its access and the owner's gates.
    readonly granted: readonly string[];
    // Connected capability ids the role leaves out of this turn: an account it does not speak through, or one an
    // access profile listing it leaves out. Another role could have them (needs/kinds/grant-need.ts).
    readonly withheldByRole: readonly string[];
    // Connected capability ids a gate holds for a named approver.
    readonly withheldByGate: readonly string[];
    // Connected capability ids the people and services this conversation works for were not given, whatever role it
    // wears: final, nothing raises for them.
    readonly withheldByReach: readonly string[];
    // The folders this turn's file tools may touch; undefined is the whole workspace.
    readonly fence: readonly string[] | undefined;
    // The folders it may touch whatever role it wears: the fence it was born with. A folder inside this and outside
    // `fence` is one its role's access holds back.
    readonly accessFence?: readonly string[] | undefined;
    // The shelves open to it, fully resolved: the full toolbox held under everything it acts for, its role included.
    readonly powers: RolePowers;
    // The most its tools may be as the people and services it acts for are held to, whatever role it wears
    // (access/principal-chain.ts). A shelf it withholds is final for this conversation. Undefined is no ceiling.
    readonly ceiling?: ToolCeiling | undefined;
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
