import { join } from "node:path";
import { ciDocument, type CiStore, fileCiStore } from "./ci-store.js";
import { type CiHookReconciler, createCiHookReconciler } from "./hooks.js";
import { createRunsCache, type RunsCache } from "./runs-cache.js";

// CI: the connected pipelines, their runs, and the hooks that report them.
export interface CiSlice {
    // CI state: the webhook secret plus per repo+branch conclusion memory that reads a recovery as pipeline_fixed.
    readonly ciStore: CiStore;
    // The Pipelines view's read model: webhook deliveries freshen it, /ci/runs backfills it when stale.
    readonly ciRuns: RunsCache;
    // Keeps every mapped repo's provider webhook pointing at this sandbox; its warnings ride /ci/runs.
    readonly ciHooks: CiHookReconciler;
}

export type CiDeps = Omit<Parameters<typeof createCiHookReconciler>[0], "ciStore">;

// Builds the CI slice; the hook reconciler reads the same store the routes edit.
export const createCiSlice = (deps: CiDeps): CiSlice => {
    const ciStore = fileCiStore(join(deps.workspace.root, ciDocument.path));
    return { ciStore, ciRuns: createRunsCache(), ciHooks: createCiHookReconciler({ ...deps, ciStore }) };
};
