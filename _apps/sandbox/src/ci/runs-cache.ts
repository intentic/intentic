import type { PipelineRun } from "@intentic/sandbox-contract";

// The Pipelines view's read model: a REST backfill sweep fills it (GET /ci/runs finding it stale), webhook
// deliveries freshen single runs in place between sweeps. An upsert deliberately does NOT extend the sweep
// freshness — one delivered run says nothing about the rest of the picture.

const TTL_MS = 20_000;
const RUNS_KEPT = 100;

export interface RunsCache {
    // The cached picture, or undefined when no sweep landed within the TTL — time to backfill.
    readonly sweep: () => PipelineRun[] | undefined;
    readonly replace: (runs: PipelineRun[]) => PipelineRun[];
    readonly upsert: (run: PipelineRun) => void;
}

const keyOf = (run: PipelineRun): string => `${run.host}\n${run.project}\n${run.runId}`;
const newestFirst = (runs: PipelineRun[]): PipelineRun[] => runs.toSorted((a, b) => b.createdAt - a.createdAt).slice(0, RUNS_KEPT);

export const createRunsCache = (ttlMs = TTL_MS): RunsCache => {
    let runs: PipelineRun[] = [];
    let sweptAt = 0;
    return {
        sweep: () => (Date.now() - sweptAt <= ttlMs ? runs : undefined),
        replace: (fresh) => {
            runs = newestFirst(fresh);
            sweptAt = Date.now();
            return runs;
        },
        upsert: (run) => {
            runs = newestFirst([run, ...runs.filter((kept) => keyOf(kept) !== keyOf(run))]);
        },
    };
};
