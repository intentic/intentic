import type { Holding } from "../../agents/actor/conversation-holdings.js";
import type { SubagentRecord } from "./subagents.js";

// The subagent roster's records, by child id (the spawning call's, or a spawned child's own conversation id), held by
// the conversation whose turn or child it is. Declared apart from subagents.ts so child-verification.ts can file a
// child's ledger with the same holder without importing the roster that imports it.
export const ROSTER: Holding<SubagentRecord> = { name: "subagents" };
