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

/** Live and total child counts for a conversation, the fleet card's count chip, read off the actors the card is. */
export const subagentCountsOf = (actors: Pick<ConversationActors, "holdings">, conversationId: string) => {
    const own = actors.holdings(ROSTER).of(conversationId);
    return { running: own.filter(subagentRunning).length, total: own.length };
};
