import { randomUUID } from "node:crypto";
import type { SyncChanges } from "@intentic/sandbox-contract/schemas/devices";
import { workspaceSyncIgnores } from "@intentic/sandbox-contract/sync/workspace-sync-ignores";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";

/* THE WORKSPACE TELLS A DEVICE WHEN IT CHANGED (2026-11-24). A device's file sync used to notice a change made here only
   by rescanning all of /work every 2 seconds (machine sync/mutagen.ts SANDBOX_POLL_SECONDS): Mutagen's Linux agent has
   no recursive watcher. Measured, that scan of ~18k entries cost 3.6% of a core around the clock, idle or not. The
   daemon already watches the tree (workspace/watch/workspace-watch.ts: one recursive watcher, batches 250 ms apart), so
   each batch holding a path the workspace session carries (sandbox-contract sync/workspace-sync-ignores.ts) moves a
   generation here, and a device holding GET /system/sync/changes open asks for a sync cycle when it does. No watch of
   its own, so no new inotify watches, and a hot file under an ignored folder (a transcript under .intentic, a build's
   dist/) moves nothing. A batch with no paths is the watcher saying "too many to name", read as a change. */

// A batch counts when any of its paths is one the workspace session carries, or when it names none (too many to list).
export const batchCarried = (paths: readonly string[], ignored: (relPath: string) => boolean = workspaceSyncIgnores): boolean =>
    paths.length === 0 || paths.some((path) => !ignored(path));

// How long a device's ask is held before it is answered with nothing new: well under any proxy's idle cut, and long
// enough that an idle sandbox costs a device one request per hold.
const SYNC_CHANGES_HOLD_MS = 25_000;

export interface SyncChangeFeed {
    // Feeds one watcher batch in; the generation moves at most once per batch, however many paths it holds.
    readonly batch: (paths: readonly string[]) => void;
    readonly current: () => SyncChanges;
    // Answers at once when `epoch` is not this run's or `after` is behind, else at the next change, the hold's end, or
    // the caller going away.
    readonly next: (after: number | undefined, epoch: string | undefined, holdMs: number, signal?: AbortSignal) => Promise<SyncChanges>;
}

export const createSyncChangeFeed = (ignored: (relPath: string) => boolean = workspaceSyncIgnores, epoch: string = randomUUID()): SyncChangeFeed => {
    let generation = 0;
    const waiters = new Set<() => void>();
    const current = (): SyncChanges => ({ epoch, generation });
    return {
        batch: (paths) => {
            if (!batchCarried(paths, ignored)) {
                return;
            }
            generation += 1;
            for (const wake of waiters) {
                wake();
            }
        },
        current,
        next: (after, asked, holdMs, signal) => {
            if (asked !== epoch || after === undefined || after !== generation || signal?.aborted === true) {
                return Promise.resolve(current());
            }
            return new Promise((resolve) => {
                const done = (): void => {
                    clearTimeout(timer);
                    waiters.delete(done);
                    signal?.removeEventListener("abort", done);
                    resolve(current());
                };
                const timer = setTimeout(done, holdMs);
                waiters.add(done);
                signal?.addEventListener("abort", done, { once: true });
            });
        },
    };
};

// The daemon's one feed, fed by the workspace watcher from boot (bootstrap/change-reactions.ts).
export const syncChangeFeed: SyncChangeFeed = createSyncChangeFeed();

// GET /system/sync/changes, held open until the feed moves past `after`. The sync token admits it (grants.ts,
// `sync: "pipe"`), so a reader holds nothing more than the generation of a tree it already syncs.
export const syncChangesRoute =
    (feed: SyncChangeFeed = syncChangeFeed, holdMs: number = SYNC_CHANGES_HOLD_MS) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const after = Number(c.req.query("after"));
        return c.json(await feed.next(Number.isSafeInteger(after) && after >= 0 ? after : undefined, c.req.query("epoch"), holdMs, c.req.raw.signal));
    };
