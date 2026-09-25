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
import { readFileSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// turbo.json `concurrency`: tasks running at once, each forking its own workers.
const TURBO_CONCURRENCY = 4;
const GIB = 1024 ** 3;
// One bun worker's share in the fan-out: two of the four concurrent tasks are the heavy packages, so this is between
// the web worker's 3 GiB and the rest.
const WORKER_BYTES = 1.5 * GIB;
// One bun worker on the web package at its peak (measured 2026-09-25: 2.4 to 3.2 GiB over the web suite), the size a
// lone `suites` run sizes to.
const STANDALONE_WORKER_BYTES = 3 * GIB;
// One typecheck task's share: most packages' tsgo or vue-tsc settle under 1 GiB, the web package's vue-tsc may take its
// 4 GiB heap, and at most one of those runs among the others.
const TYPECHECK_BYTES = 2 * GIB;
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

const readText = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        // silent-catch: a file the platform does not have (no /proc on macOS, no cgroup v2) is the absent reading every caller handles
        return undefined;
    }
};

// The kernel's own estimate of what can be handed out without swapping (`MemAvailable`, bytes), or undefined off Linux.
export const memAvailable = (path = "/proc/meminfo") => {
    const kib = /^MemAvailable:\s+(\d+) kB$/m.exec(readText(path) ?? "")?.[1];
    return kib === undefined ? undefined : Number(kib) * 1024;
};

// What this process may still use: the machine's available memory, and under a cgroup ceiling what is left below it,
// counting the page cache the cgroup would drop first as free. The smaller of the two, since either one refuses first.
export const availableMemory = ({ meminfo = "/proc/meminfo", cgroup = "/sys/fs/cgroup" } = {}) => {
    const host = memAvailable(meminfo) ?? freemem();
    const limit = cgroupMemoryLimit(join(cgroup, "memory.max"));
    const current = Number(readText(join(cgroup, "memory.current"))?.trim());
    if (limit === undefined || !Number.isFinite(current)) {
        return limit === undefined ? host : Math.min(host, limit);
    }
    const reclaimable = Number(/^inactive_file (\d+)$/m.exec(readText(join(cgroup, "memory.stat")) ?? "")?.[1] ?? 0);
    return Math.max(0, Math.min(host, limit - current + reclaimable));
};

// cgroup v2's ceiling in bytes, or undefined where there is none to read: `max`, no such file (macOS, Windows, cgroup
// v1), or a value that is not a positive number.
export const cgroupMemoryLimit = (path = "/sys/fs/cgroup/memory.max") => {
    const text = readText(path)?.trim();
    if (text === undefined || text === "max") {
        return undefined;
    }
    const bytes = Number(text);
    return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
};

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
