#!/usr/bin/env node
// How many workers each vitest in a repo-wide run may fork, sized to this cgroup's memory rather than its cpus: turbo
// runs four tasks at once, a fork of this repo's suites holds about half a GiB, and the fan-out may take half the box.
// Prints the number when run; a `VITEST_MAX_WORKERS` already set wins, so a caller's own value is never second-guessed.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The ceiling measured safe on a 16 GiB sandbox; memory can only lower it.
export const MAX_WORKERS = 4;
// turbo.json `concurrency`: tasks running at once, each forking its own workers.
const TURBO_CONCURRENCY = 4;
const WORKER_BYTES = 512 * 1024 ** 2;
const FAN_OUT_SHARE = 0.5;

// Workers per task for a box of `limitBytes`; an unmeasured box gets the ceiling, and no box gets fewer than one.
export const workersFor = (limitBytes) => {
    if (limitBytes === undefined) {
        return MAX_WORKERS;
    }
    const fits = Math.floor((limitBytes * FAN_OUT_SHARE) / (TURBO_CONCURRENCY * WORKER_BYTES));
    return Math.min(MAX_WORKERS, Math.max(1, fits));
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

// The value to hand vitest, as a string for an env block. An empty variable counts as unset, as `${VAR:-}` reads it.
export const vitestMaxWorkers = (env = process.env, limitBytes = cgroupMemoryLimit()) => {
    const own = env.VITEST_MAX_WORKERS;
    return own !== undefined && own !== "" ? own : String(workersFor(limitBytes));
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(vitestMaxWorkers());
}
