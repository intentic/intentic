import type { WorkflowRunsStore, WorkflowsStore } from "../workflows/workflows-store.js";
import type { LoopDesignsStore, LoopsStore } from "./loops-store.js";

// Loops and workflows: their saved designs and their run ledgers.
export interface LoopsSlice {
    // Ralph loops: the pump drives them, /loops starts/stops them; `running` at boot is what the daemon died under.
    readonly loops: LoopsStore;
    // Saved loops: the manifest half, a loop's machinery with its goal left out for the composer to supply.
    readonly loopDesigns: LoopDesignsStore;
    // Workflow designs, a manifest the user authors at human speed; /workflows edits it, nothing fires it alone.
    readonly workflows: WorkflowsStore;
    // Workflow runs, the ledger the scheduler writes per step; kept apart so a run outlives a deleted design.
    readonly workflowRuns: WorkflowRunsStore;
}
