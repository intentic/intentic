import { join } from "node:path";
import type { WorkflowRunsStore, WorkflowsStore } from "../workflows/workflows-store.js";
import { fileLoopDesignsStore, fileLoopsStore, loopDesignsDocument, type LoopDesignsStore, loopsDocument, type LoopsStore } from "./loops-store.js";

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

// The members workflows/ builds, which composition.ts adds: building them here would close loops -> workflows -> loops.
export type WorkflowsMembers = "workflows" | "workflowRuns";

// Builds the loops half of the slice: two documents under the workspace root, nothing else read.
export const createLoopsSlice = (workspaceRoot: string): Omit<LoopsSlice, WorkflowsMembers> => ({
    loops: fileLoopsStore(join(workspaceRoot, loopsDocument.path)),
    loopDesigns: fileLoopDesignsStore(join(workspaceRoot, loopDesignsDocument.path)),
});
