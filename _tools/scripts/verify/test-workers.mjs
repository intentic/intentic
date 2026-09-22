#!/usr/bin/env node
// How many workers each `bun test` in a repo-wide run may fork, sized to this cgroup's memory rather than its cpus:
// turbo runs four tasks at once, a bun worker on the web package (jsdom + Vue) sits between 0.5 and 1 GiB after a few
// hundred files, and the fan-out may take half the box. Prints the number when run; a `TEST_WORKERS` already set wins, so a caller's own value is never
// second-guessed.
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";

// turbo.json `concurrency`: tasks running at once, each forking its own workers.
const TURBO_CONCURRENCY = 4;
// Working set of one bun worker on the web package, the repo's heaviest per worker; its peak is twice this, which
// FAN_OUT_SHARE covers.
const WORKER_BYTES = 512 * 1024 ** 2;
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

// The value to hand `suites`, as a string for an env block. An empty variable counts as unset, as `${VAR:-}` reads it.
export const testWorkers = (env = process.env, limitBytes = cgroupMemoryLimit()) => {
    const own = env.TEST_WORKERS;
    return own !== undefined && own !== "" ? own : String(workersFor(limitBytes));
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(testWorkers());
}
