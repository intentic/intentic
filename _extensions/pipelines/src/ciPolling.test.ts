import type { PipelineRun } from "@intentic/sandbox-contract";
import { describe, it, expect } from "bun:test";
import { runsPollMs } from "./usePipelines";
import { jobsPollMs } from "./useRunJobs";

// What the board and a row ask the daemon for, and how often: the push (runtime-state's `ci`) only reaches a repo
// whose hook delivers, so these intervals are what a reader watching a run land actually waits out.

const run = (status: PipelineRun[`status`]): PipelineRun => ({
    repo: `web`,
    host: `github`,
    project: `acme/shop-web`,
    runId: 1,
    branch: `main`,
    sha: `c41f9ab`,
    status,
    url: `https://github.com/acme/shop-web/actions/runs/1`,
    createdAt: 0,
});

describe(`the Pipelines poll`, () => {
    it(`tightens while a run is in flight and loosens once the board is settled`, () => {
        const watching = runsPollMs([run(`success`), run(`running`)]);
        const quiet = runsPollMs([run(`success`), run(`failed`)]);

        expect(watching).toBeLessThan(quiet);
        // Queued is not running, and a board holding only queued work is just as much worth watching.
        expect(runsPollMs([run(`queued`)])).toBe(watching);
    });

    it(`treats an unanswered board as settled rather than as work in flight`, () => {
        expect(runsPollMs(undefined)).toBe(runsPollMs([]));
    });

    it(`re-reads an in-flight run's jobs and stops once the graph is final`, () => {
        expect(jobsPollMs(run(`running`))).toBeGreaterThan(0);
        expect(jobsPollMs(run(`queued`))).toBeGreaterThan(0);
        for (const status of [`success`, `failed`, `canceled`, `skipped`] as const) {
            expect(jobsPollMs(run(status))).toBe(false);
        }
        expect(jobsPollMs(undefined)).toBe(false);
    });
});
