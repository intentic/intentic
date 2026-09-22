#!/usr/bin/env node
// How many workers each `bun test` in a repo-wide run may fork, sized to this cgroup's memory rather than its cpus:
// turbo runs four tasks at once, a bun worker on the web package (jsdom + Vue) settles near 2 GiB and one on the daemon
// near 1.4 GiB, the other packages stay far below, and the fan-out may take half the box. Prints the number when run; a `TEST_WORKERS` already set wins, so a caller's own value is never
// second-guessed.
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

// Workers per task for a box of `limitBytes` and `cores` cpus. A worker past a core buys nothing, so cores are the
// ceiling; an unmeasured box gets that ceiling, and no box gets fewer than one.
export const workersFor = (limitBytes, cores = availableParallelism()) => {
    if (limitBytes === undefined) {
        return cores;
    }
    const fits = Math.floor((limitBytes * FAN_OUT_SHARE) / (TURBO_CONCURRENCY * WORKER_BYTES));
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

// Workers for one package run on its own (no fan-out): half the box at the web worker's size, never past the cores.
export const standaloneWorkers = (limitBytes = cgroupMemoryLimit() ?? totalmem(), cores = availableParallelism()) =>
    Math.min(cores, Math.max(1, Math.floor((limitBytes * FAN_OUT_SHARE) / STANDALONE_WORKER_BYTES)));

// The value to hand `suites`, as a string for an env block. An empty variable counts as unset, as `${VAR:-}` reads it.
export const testWorkers = (env = process.env, limitBytes = cgroupMemoryLimit()) => {
    const own = env.TEST_WORKERS;
    return own !== undefined && own !== "" ? own : String(workersFor(limitBytes));
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(testWorkers());
}
