import type { AgentSummary } from "@intentic/sandbox-contract";
import { cardProjection } from "../agents/card-projection.js";

/* WHAT THE FLEET CARD SAYS ABOUT A WORKFLOW STEP — which run this conversation belongs to, and where in it.
 *
 * The mechanism is card-projection.ts; this is only the workflow's use of it. The scheduler publishes when a
 * step starts, which is the one moment the answer changes: a `fresh` step's conversation is new and has never
 * said anything, and a `continue` step's is the one its predecessor was already on and now has a new name for
 * what it is doing.
 *
 * It is never cleared when the run ends. Which run a conversation came out of is the thing its card is read for
 * afterwards — a week later, "why does this branch exist" is answered by the run it was a step of.
 */

export type WorkflowProjection = NonNullable<AgentSummary["workflow"]>;

export const workflowProjection = cardProjection<WorkflowProjection>();
