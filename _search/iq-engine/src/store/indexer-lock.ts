import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Declares which process owns writing the index; a process that finds a live owner queries instead of writing.
// Ownership is a pid file: no heartbeat needed, since resolving the pid answers whether the owner is alive.

const lockPath = (dir: string): string => join(dir, "indexer.pid");

// Overwrites unconditionally: a stale pid names nothing, and a live owner could not have reached this call (single
// daemon instance per workspace).
export const claimIndexer = (dir: string): void => {
    writeFileSync(lockPath(dir), String(process.pid));
};

export const releaseIndexer = (dir: string): void => {
    rmSync(lockPath(dir), { force: true });
};

// True only for a different live process; this process's own pid, and an unreadable, empty, or dead pid, all read as
// unowned.
export const indexerAlive = (dir: string): boolean => {
    let raw: string;
    try {
        raw = readFileSync(lockPath(dir), "utf8");
    } catch {
        return false;
    }
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return false;
    }
    try {
        // Signal 0 is a liveness probe: no signal is delivered, the call just fails if the pid is gone.
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
