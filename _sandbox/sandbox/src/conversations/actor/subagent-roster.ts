import type { SubagentSession, SubagentStatus } from "@intentic/sandbox-contract/schemas/terminal";
import type { ConversationActors } from "./conversation-actors.js";
import type { Holding } from "./conversation-holdings.js";
import type { SubagentRecord } from "../../agent/subagents/subagents.js";

// The subagent roster's records, by child id (the spawning call's, or a spawned child's own conversation id), held by
// the conversation whose turn or child it is. Declared apart from subagents.ts so child-verification.ts can file a
// child's ledger with the same holder without importing the roster that imports it.
export const ROSTER: Holding<SubagentRecord> = { name: "subagents" };

export const LIVE: ReadonlySet<SubagentStatus> = new Set<SubagentStatus>(["pending", "running", "blocked", "paused"]);
export const subagentRunning = (record: Pick<SubagentSession, "status">): boolean => LIVE.has(record.status);

// A child at work: started or about to start. A paused child waits on a reset and a blocked one on a person, whenever
// either comes.
const AT_WORK: ReadonlySet<SubagentStatus> = new Set<SubagentStatus>(["pending", "running"]);

/**
 * How many of a conversation's children are at work and will tell it how they ended in a turn of its own: spawned ones and
 * ones handed over a link. An in-process subagent lives and dies with its parent's turn, so none is left once it ends.
 */
export const childrenAtWorkOf = (actors: Pick<ConversationActors, "holdings">, conversationId: string): number =>
    actors
        .holdings(ROSTER)
        .of(conversationId)
        .filter((record) => record.kind !== "subagent" && AT_WORK.has(record.status)).length;

/** Live and total child counts for a conversation, the fleet card's count chip, read off the actors the card is. */
export const subagentCountsOf = (actors: Pick<ConversationActors, "holdings">, conversationId: string) => {
    const own = actors.holdings(ROSTER).of(conversationId);
    return { running: own.filter(subagentRunning).length, total: own.length };
};
