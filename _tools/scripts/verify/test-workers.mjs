#!/usr/bin/env node
// How many workers each `bun test` may fork, and how many typecheck and test tasks may run at once, sized to the memory
// FREE when the run starts rather than to the machine's size: a sandbox runs several conversations, a local model, a
// browser and the post-land check side by side, and a run that sized itself to the whole box while half of it was taken
// is how one check swapped a 32 GB laptop to a standstill. A bun worker on the web package (jsdom + Vue) climbs to
// about 3 GiB, one on the daemon stays near 1.4 GiB, the other packages far below, and a run may take half of what is
// free. Prints the worker count when run; a `TEST_WORKERS` already set wins, so a caller's own value is never
// second-guessed.
//
// THE BOX IS NOT ALWAYS THIS JOB'S ALONE, and at the moment six jobs start nothing any of them reads says so: each sees
// the same free memory. `CI_HOST_JOBS` is how the caller supplies the part that cannot be measured.
import { availableParallelism, freemem } from "node:os";
import { askFreeSync, TEST_PROCESS_BYTES } from "../../constants/src/memory-room.mjs";
import { pathToFileURL } from "node:url";

// turbo.json `concurrency`: tasks running at once, each forking its own workers.
const TURBO_CONCURRENCY = 4;
// Peak sizes per worker and per typecheck task, measured, in the one place the sizes live.
const WORKER_BYTES = TEST_PROCESS_BYTES.fanOutWorker;
const STANDALONE_WORKER_BYTES = TEST_PROCESS_BYTES.standaloneWorker;
const TYPECHECK_BYTES = TEST_PROCESS_BYTES.typecheck;
const FAN_OUT_SHARE = 0.5;

// How many jobs run beside this one on the same machine, which no cgroup reports and nothing here can measure: the CI
// fleet is six runner processes on ONE box (docs/ops/ci-runner.md), so six of these fan-outs divide one pool of
// memory. Unset means a lone run, which is every developer machine and every job that is the only one on its host.
export const hostJobs = (env = process.env) => {
    const raw = Number(env.CI_HOST_JOBS);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
};

// Workers per task when `freeBytes` are free on a box of `cores` cpus, sharing it with `jobs - 1` other jobs. A worker
// past a core buys nothing, so cores are the ceiling; no box gets fewer than one.
export const workersFor = (freeBytes = availableMemory(), cores = availableParallelism(), jobs = 1) => {
    const fits = Math.floor((freeBytes * FAN_OUT_SHARE) / (jobs * testConcurrency(freeBytes, jobs) * WORKER_BYTES));
    return Math.min(cores, Math.max(1, fits));
};

// Test tasks to run at once: turbo's four where each can hold at least one worker, fewer when the free memory cannot.
export const testConcurrency = (freeBytes = availableMemory(), jobs = hostJobs()) =>
    Math.min(TURBO_CONCURRENCY, Math.max(1, Math.floor((freeBytes * FAN_OUT_SHARE) / (jobs * WORKER_BYTES))));

// Typecheck tasks to run at once when `freeBytes` are free, turbo's own four at most.
export const typecheckConcurrency = (freeBytes = availableMemory(), jobs = hostJobs()) =>
    Math.min(TURBO_CONCURRENCY, Math.max(1, Math.floor(freeBytes / (jobs * TYPECHECK_BYTES))));

// What this run may still use: the sandbox's free memory by the one room formula (@intentic/constants/memory-room: the
// limit less the working set and swap, never more than the machine has available, less what the daemon just admitted),
// asked of the daemon where one runs and read off the same files where none does. The machine's free memory only where
// neither can say (macOS, Windows). Asked once per process: every default argument below reads the same figure.
let asked;
export const availableMemory = () => (asked ??= askFreeSync() ?? freemem());

// Workers for one package run with no turbo fan-out above it: half of what is free at the web worker's size, split with
// whatever else shares the machine, never past the cores. `jobs` matters here too — this is what `suites` falls back
// to when nothing set TEST_WORKERS, so it is the number a job that forgot the env gets.
export const standaloneWorkers = (freeBytes = availableMemory(), cores = availableParallelism(), jobs = hostJobs()) =>
    Math.min(cores, Math.max(1, Math.floor((freeBytes * FAN_OUT_SHARE) / (jobs * STANDALONE_WORKER_BYTES))));

// The value to hand `suites`, as a string for an env block. An empty variable counts as unset, as `${VAR:-}` reads it.
export const testWorkers = (env = process.env, freeBytes = availableMemory()) => {
    const own = env.TEST_WORKERS;
    return own !== undefined && own !== "" ? own : String(workersFor(freeBytes, availableParallelism(), hostJobs(env)));
};

// `node test-workers.mjs` prints TEST_WORKERS; `--test-concurrency` and `--typecheck-concurrency` print the task counts
// the root `test` and `typecheck` scripts hand turbo.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [flag] = process.argv.slice(2);
    console.log(flag === "--test-concurrency" ? testConcurrency() : flag === "--typecheck-concurrency" ? typecheckConcurrency() : testWorkers());
}
