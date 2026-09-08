export { activate } from "./extension.js";
export { manifest } from "./manifest.js";

// Re-exports the shared graph derivation (`workflowDag`) and node card so any surface drawing a workflow run, including
// the chat panel's popped-out window, uses the exact same picture. Exported from the index rather than reached into
// directly, as the package's public surface.
export { STEP_TONE, type StepTone, stepSubtitle, workflowDag, type WorkflowDag, type WorkflowNode } from "./workflowDag.js";
export { default as WorkflowNodeCard } from "./WorkflowNodeCard.vue";
