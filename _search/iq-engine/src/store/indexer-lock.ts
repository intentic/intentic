import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* WHO OWNS WRITING THIS INDEX — the invariant that keeps a search from failing because the index was busy being
 * updated.
 *
 * SQLite in WAL mode lets any number of readers run straight through a writer, but it admits exactly ONE writer
 * at a time. That was fine while the index had one: the daemon's resident engine indexes on a worker thread and
 * queries through a handle that only reads. The CLI engine is a different process, and it revalidates the whole
 * workspace inline on every invocation — so in a sandbox, every `iq` call was a second writer racing the
 * daemon's sweep, and the one that lost got SQLITE_BUSY and exited 2. Both writers were doing the SAME work;
 * only one of them had to.
 *
 * So ownership is declared rather than assumed: the resident engine claims the index for the life of its
 * process, and an engine that finds a LIVE owner never writes at all — it queries what the owner has already
 * indexed. The pid file is the whole mechanism. It needs no heartbeat and no expiry because the question it
 * answers ("is that process still there?") is one the OS answers exactly, and a daemon killed mid-pass leaves
 * behind a pid that no longer resolves — which reads as "unowned", which is the truth. */

const lockPath = (dir: string): string => join(dir, "indexer.pid");

// Claimed by the resident engine on open; dropped on close. Overwrites unconditionally: a file left by a dead
// process names nothing, and a live one could not have got here (the daemon is single-instance per workspace).
export const claimIndexer = (dir: string): void => {
    writeFileSync(lockPath(dir), String(process.pid));
};

export const releaseIndexer = (dir: string): void => {
    rmSync(lockPath(dir), { force: true });
};

// Whether a DIFFERENT live process owns writing this index. Its own pid reads as unowned so the owner keeps
// writing through its own lock; an unreadable, empty, or dead pid does too.
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
        // Signal 0 is the liveness probe: no signal is delivered, it just fails when the pid is gone.
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
