import type { FleetContext } from "../context.js";
import { readWorkers } from "../discover.js";
import type { JanitorConfig } from "./janitor-config.js";
import { gb, removeTree, type Trash } from "./janitor-fs.js";
import type { PassRecord } from "./pass-record.js";

/* ONE JANITOR PASS'S SHARED STATE, and the two things every rule does: ask whether a runner (or any) is running a job
   right now, and remove a tree through the trash with a reason. Busy is asked again before every removal, as
   fleet-janitor.sh's runner_busy was: a job can start at any moment of an hour-long pass. */

export interface JanitorRun {
    readonly context: FleetContext;
    readonly config: JanitorConfig;
    readonly cacheRoot: string;
    readonly record: PassRecord;
    readonly trash: Trash;
    readonly now: number;
    // The sizes this pass measured of the cache root's entries, for the status's `caches` without a second du.
    readonly measured: Map<string, number>;
}

// The runner folders whose Runner.Worker is alive, i.e. that are executing a job right now.
export const busyFolders = async (run: JanitorRun): Promise<Set<string>> => new Set((await readWorkers(run.context.sys)).keys());

export const runnerBusy = async (run: JanitorRun, dir: string): Promise<boolean> => (await busyFolders(run)).has(dir);

export const fleetBusy = async (run: JanitorRun): Promise<boolean> => (await busyFolders(run)).size > 0;

export const wouldOr = (run: JanitorRun, done: string): string => (run.record.dryRun ? "would remove" : done);

/** Removes `path` through the trash and answers the bytes it held; with a reason it says so, as the script's `remove`.
 *  A path that is not there removes nothing and says nothing. */
export const remove = async (run: JanitorRun, path: string, why?: string): Promise<number> => {
    const removal = await removeTree(run.trash, path, run.now);
    if (!removal.removed) {
        if (removal.problem !== undefined) {
            run.record.say(`could not remove ${path}`);
        }
        return 0;
    }
    run.measured.delete(path);
    if (!run.record.dryRun) {
        run.record.freedBytes += removal.bytes;
    }
    if (why !== undefined) {
        run.record.say(`${wouldOr(run, "removed")} ${path} (${gb(removal.bytes)} GB): ${why}`);
    }
    return removal.bytes;
};
