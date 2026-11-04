import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const HISTORY_PER_RUN = 8;
const RETAINED_RUNS = 24;

const usable = (path: string): boolean => {
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        return value !== null && Object.getPrototypeOf(value) === Object.prototype;
    } catch {
        // allow(silent-catch): malformed or unreadable history is ignored so tests still run
        return false;
    }
};

// Bun writes a new immutable history and merges the recent ones into it, so filtered runs and shards retain timings for
// files they did not execute. Missing, malformed or unwritable history simply leaves scheduling at Bun's default.
export const timingArgs = (directory: string | undefined, packageName: string, kind: string): Array<string> => {
    if (directory === undefined || directory === "") {
        return [];
    }
    try {
        mkdirSync(directory, { recursive: true });
        const prefix = `${packageName.replace(/[^a-zA-Z0-9_-]+/gu, "_")}.${kind}.`;
        const history = readdirSync(directory)
            .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
            .map((name) => ({ path: join(directory, name), modified: statSync(join(directory, name)).mtimeMs }))
            .toSorted((a, b) => b.modified - a.modified);
        // One slot is kept for the history this run writes, so RETAINED_RUNS remain once it has.
        for (const stale of history.slice(RETAINED_RUNS - 1)) {
            rmSync(stale.path, { force: true });
        }
        const current = join(directory, `${prefix}${randomUUID()}.json`);
        const selected: Array<string> = [];
        for (const { path } of history.slice(0, RETAINED_RUNS - 1)) {
            if (selected.length === HISTORY_PER_RUN) {
                break;
            }
            if (usable(path)) {
                selected.push(path);
            }
        }
        return [`--timings=${current}`, ...selected.map((path) => `--timings=${path}`), "--update-timings"];
    } catch {
        // allow(silent-catch): timing I/O is optional and must never prevent the test run
        return [];
    }
};
