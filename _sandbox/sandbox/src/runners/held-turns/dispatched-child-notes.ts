import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import type { Holding } from "../../conversations/actor/conversation-holdings.js";

/**
 * The note its parent's sandbox wrote for a spawned child whose turn runs on this runner (the "You are a subagent" note,
 * agent/subagents/starting/child-preamble.ts), filed as the dispatched turn arrives (runner-service.ts) and taken by that
 * turn's plan. A runner holds no record of the child, its siblings or where its work lands to write one from, so the two
 * children placed on a runner in the shinobi-society audit (2026-11-21) went without it.
 */
export const DISPATCHED_CHILD_NOTES: Holding<TurnNote> = { name: "dispatched child notes" };
