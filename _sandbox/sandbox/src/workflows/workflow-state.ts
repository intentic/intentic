import type { AgentSummary, WorkflowRun } from "@intentic/sandbox-contract";
import { cardProjection } from "../agents/registry/card-projection.js";

// What the fleet card says about a workflow step: which run its conversation belongs to, and where. Uses
// card-projection.ts, published only when a step starts, since that's the one moment the answer changes. Never cleared
// when the run ends: a card is read for this long after, to answer why does this branch exist.

export type WorkflowProjection = NonNullable<AgentSummary["workflow"]>;

export const workflowProjection = cardProjection<WorkflowProjection>();

// Conversations a run owns: every step that took a turn, deduped, since a `continue` step shares its predecessor's.
// `pending` and `skipped` are excluded: those ids are derived strings written before the chat existed.
export const runConversations = (run: WorkflowRun): string[] => [
    ...new Set(run.steps.filter((step) => step.state !== "pending" && step.state !== "skipped").map((step) => step.conversationId)),
];
