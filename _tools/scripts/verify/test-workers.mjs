#!/usr/bin/env node
// How many workers each `bun test` in a repo-wide run may fork, sized to the memory available rather than to the cpus:
// turbo runs four tasks at once, a bun worker on the web package (jsdom + Vue) settles near 2 GiB and one on the daemon
// near 1.4 GiB, the other packages stay far below, and the fan-out may take half of what is going spare. Prints the
// number when run; a `TEST_WORKERS` already set wins, so a caller's own value is never second-guessed.
//
// THE BOX IS NOT ALWAYS THIS JOB'S ALONE, and nothing the process can read says so — a CI container started without
// `--memory` reports no cgroup ceiling and the whole machine's RAM, identically whether it is the only job on the host
// or one of six. `CI_HOST_JOBS` is how the caller supplies the part that cannot be measured.
import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { pathToFileURL } from "node:url";

// turbo.json `concurrency`: tasks running at once, each forking its own workers.
const TURBO_CONCURRENCY = 4;
// One bun worker's share in the fan-out: two of the four concurrent tasks are the heavy packages, so this is between
// the web worker's 2 GiB and the rest.
const WORKER_BYTES = 1024 ** 3;
// One bun worker on the web package, the ceiling a lone `suites` run sizes to.
const STANDALONE_WORKER_BYTES = 2 * 1024 ** 3;
const FAN_OUT_SHARE = 0.5;

// How many jobs run beside this one on the same machine, which no cgroup reports and nothing here can measure: the CI
// fleet is six runner processes on ONE box (docs/ops/ci-runner.md), so six of these fan-outs divide one pool of
// memory. Unset means a lone run, which is every developer machine and every job that is the only one on its host.
export const hostJobs = (env = process.env) => {
    const raw = Number(env.CI_HOST_JOBS);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
};

// Workers per task for a box of `limitBytes` and `cores` cpus, sharing it with `jobs - 1` other jobs. A worker past a
// core buys nothing, so cores are the ceiling; no box gets fewer than one.
//
// An unmeasured box is MEASURED — `totalmem()`, as standaloneWorkers already does — never handed the core count. That
// fallback is not the rare case it reads as: a job container started without `--memory` has no cgroup ceiling at all,
// so every CI job took it, and the one number it cannot be is the one that ignores memory entirely.
export const workersFor = (limitBytes = cgroupMemoryLimit() ?? totalmem(), cores = availableParallelism(), jobs = 1) => {
    const fits = Math.floor((limitBytes * FAN_OUT_SHARE) / (jobs * TURBO_CONCURRENCY * WORKER_BYTES));
    return Math.min(cores, Math.max(1, fits));
};

// cgroup v2's ceiling in bytes, or undefined where there is none to read: `max`, no such file (macOS, Windows, cgroup
// v1), or a value that is not a positive number.
export const cgroupMemoryLimit = (path = "/sys/fs/cgroup/memory.max") => {
    try {
        const text = readFileSync(path, "utf8").trim();
        if (text === "max") {
            return undefined;
        }
        const bytes = Number(text);
        return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
    } catch {
        return undefined;
    }
};

// Workers for one package run with no turbo fan-out above it: half the box at the web worker's size, split with
// whatever else shares the machine, never past the cores. `jobs` matters here too — this is what `suites` falls back
// to when nothing set TEST_WORKERS, so it is the number a job that forgot the env gets.
export const standaloneWorkers = (limitBytes = cgroupMemoryLimit() ?? totalmem(), cores = availableParallelism(), jobs = hostJobs()) =>
    Math.min(cores, Math.max(1, Math.floor((limitBytes * FAN_OUT_SHARE) / (jobs * STANDALONE_WORKER_BYTES))));

// The value to hand `suites`, as a string for an env block. An empty variable counts as unset, as `${VAR:-}` reads it.
export const testWorkers = (env = process.env, limitBytes = cgroupMemoryLimit() ?? totalmem()) => {
    const own = env.TEST_WORKERS;
    return own !== undefined && own !== "" ? own : String(workersFor(limitBytes, availableParallelism(), hostJobs(env)));
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(testWorkers());
}
