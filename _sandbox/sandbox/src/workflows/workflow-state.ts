import type { WorkflowRun } from "@intentic/sandbox-contract";

// Conversations a run owns: every step that took a turn, deduped, since a `continue` step shares its predecessor's.
// `pending` and `skipped` are excluded: those ids are derived strings written before the chat existed.
export const runConversations = (run: WorkflowRun): string[] => [
    ...new Set(run.steps.filter((step) => step.state !== "pending" && step.state !== "skipped").map((step) => step.conversationId)),
];
