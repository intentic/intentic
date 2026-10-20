import type { PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import { runsPollMs } from "./usePipelines";
import { hashKey } from "@tanstack/vue-query";
import { computed, effect, ref } from "vue";
import { boardLanded, jobsPollMs, keyHash } from "./useRunJobs";

// What the board and a row ask the daemon for, and how often: the push (runtime-state's `ci`) only reaches a repo
// whose hook delivers, so these intervals are what a reader watching a run land waits out where it does not.

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

// An open in-flight row re-reads its graph when the board's runs land (each `ci` push re-reads them), not on its beat.
describe(`an open row following the board`, () => {
    const event = (type: string, action: string, queryHash: string) => ({ type, action: { type: action }, query: { queryHash } });

    it(`re-reads on the board's runs landing fresh, and on nothing else`, () => {
        expect(boardLanded(event(`updated`, `success`, `runs`), `runs`)).toBe(true);
        expect(boardLanded(event(`updated`, `fetch`, `runs`), `runs`)).toBe(false);
        expect(boardLanded(event(`updated`, `error`, `runs`), `runs`)).toBe(false);
        expect(boardLanded(event(`updated`, `success`, `jobs`), `runs`)).toBe(false);
        expect(boardLanded(event(`added`, `success`, `runs`), `runs`)).toBe(false);
    });
});

describe(`the board's cache hash`, () => {
    // A contract key ends in the live active-sandbox ref; once a computed tracks that ref, its reactive graph is cyclic,
    // and hashing the raw key crashed the whole view ("Converting circular structure to JSON").
    it(`hashes a key ending in a tracked sandbox ref as vue-query files it`, () => {
        const sandbox = ref(`box-1`);
        const tracker = computed(() => sandbox.value.length);
        // A live subscriber, as the shell's own readers of the sandbox id are: what closes the cycle.
        const runner = effect(() => tracker.value);
        const key = [`ci.runs`, sandbox];

        expect(keyHash(key)).toBe(hashKey([`ci.runs`, `box-1`]));
        sandbox.value = `box-2`;
        expect(keyHash(key)).toBe(hashKey([`ci.runs`, `box-2`]));
        runner.effect.stop();
    });
});
