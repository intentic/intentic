export { activate } from "./extension.js";
export { manifest } from "./manifest.js";

/* THE GRAPH, FOR ANYONE ELSE WHO HAS TO DRAW A RUN.
 *
 * workflowDag.ts opens by saying why it is a module and not two components' worth of computed properties: one
 * derivation, so what you author in the designer and what you watch in a run can never be different pictures of
 * the same workflow. The chat panel is now the THIRD surface that draws one, it shows a run's diagram in the
 * popped-out window so the reader can jump between its sessions, and the argument does not weaken with a third
 * consumer, it is the whole reason there is a module to import.
 *
 * The alternative was a copy in the web app, which is how two surfaces start disagreeing about which node is
 * running. Exported from the extension's index rather than reached into, because a package's public surface is
 * exactly what this is for.
 */
export { STEP_TONE, type StepTone, stepSubtitle, workflowDag, type WorkflowDag, type WorkflowNode } from "./workflowDag.js";
export { default as WorkflowNodeCard } from "./WorkflowNodeCard.vue";
