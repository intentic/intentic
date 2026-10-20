import { isPipelineInFlight, type PipelineRun } from "@intentic/sandbox-contract/schemas/ci";

// The Pipelines view's read model: a REST backfill sweep fills it (GET /ci/runs finding it stale), webhook
// deliveries freshen single runs in place between sweeps. An upsert deliberately does NOT extend the sweep
// freshness, one delivered run says nothing about the rest of the picture.

const TTL_MS = 20_000;
const RUNS_KEPT = 100;

export interface RunsCache {
    // How old a sweep may be and still be served: what a backfill already under way is held to as well (ci.routes.ts).
    readonly ttlMs: number;
    // The cached picture, or undefined when no sweep landed within the TTL, time to backfill.
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
        ttlMs,
        sweep: () => (Date.now() - sweptAt <= ttlMs ? runs : undefined),
        replace: (fresh) => {
            runs = newestFirst(fresh);
            sweptAt = Date.now();
            return runs;
        },
        upsert: (run) => {
            // In-flight deliveries freshen the board too now (2026-10-20), and a forge may deliver a run's `in_progress`
            // after its `completed`: a phase never takes back an ending already kept. A re-run under the same id shows
            // in flight from the next sweep instead, and its own ending lands here as usual.
            const held = runs.find((entry) => keyOf(entry) === keyOf(run));
            if (held !== undefined && isPipelineInFlight(run.status) && !isPipelineInFlight(held.status)) {
                return;
            }
            runs = newestFirst([run, ...runs.filter((kept) => keyOf(kept) !== keyOf(run))]);
        },
    };
};
