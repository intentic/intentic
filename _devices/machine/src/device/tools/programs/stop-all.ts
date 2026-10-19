import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readTextIfExists } from "@intentic/base/fs";
import { undefinedIfMissing } from "@intentic/base/errors";
import { parseJsonOr } from "@intentic/base/json";
import { runsRoot } from "./artifacts.js";
import { stopWindowsSandbox } from "./isolated.js";
import { type AppRun, runState, signalTree, waitGone } from "./programs.js";

/* EVERY PROGRAM `app_start` LEFT RUNNING, STOPPED FOR `uninstall --purge`. An app is started detached and outlives the
   agent on purpose (programs.ts), so a purge that only stopped the agent left whatever a sandbox had started running on
   this device, from a folder the purge then deletes. Every sandbox's record is read (`runs/<sandbox>/apps.json`), and
   each run still going is stopped with everything it started: asked first, forced after the same grace `app_stop`
   gives. A run whose pid cannot be shown to still be that program is not signalled (programs.ts runState). */

const STOP_GRACE_MS = 5000;

export interface AppsStopped {
    readonly stopped: readonly string[];
    // Runs that may still be going, each with why: their pid could not be vouched for, or the stop did not take.
    readonly left: readonly { readonly run: AppRun; readonly why: string }[];
}

const recordsUnder = async (root: string): Promise<AppRun[]> => {
    const sandboxes = ((await readdir(root, { withFileTypes: true }).catch(undefinedIfMissing)) ?? []).filter((entry) => entry.isDirectory());
    const runs: AppRun[] = [];
    for (const sandbox of sandboxes) {
        // one small file per sandbox that ever started an app here
        const parsed: unknown = parseJsonOr((await readTextIfExists(join(root, sandbox.name, "apps.json"))) ?? "", undefined);
        // SAFETY: the file is the agent's own record (programs.ts updateRuns writes it whole); read as programs.ts reads it.
        runs.push(...(Array.isArray(parsed) ? (parsed as AppRun[]) : []).filter((run) => run.endedAt === undefined));
    }
    return runs;
};

// "ended" when it was over already, "stopped" when this stopped it, else why it may still be going.
const stopOne = async (run: AppRun): Promise<string> => {
    const state = await runState(run);
    if (state === "ended") {
        return "ended";
    }
    if (state === "unknown") {
        return `whether pid ${run.pid} is still ${run.name} cannot be checked here, so it was not signalled`;
    }
    await signalTree(run.pid, false);
    if (!(await waitGone(run, STOP_GRACE_MS))) {
        await signalTree(run.pid, true);
    }
    return (await waitGone(run, STOP_GRACE_MS)) ? "stopped" : `pid ${run.pid} is still running after being forced to stop`;
};

/** Stops every app a sandbox started here that is still running; a record that cannot be read throws. */
export const stopAllApps = async (root: string = runsRoot()): Promise<AppsStopped> => {
    const runs = await recordsUnder(root);
    const stopped: string[] = [];
    const left: { run: AppRun; why: string }[] = [];
    if (runs.some((run) => run.isolated === true)) {
        // There is only ever one Windows Sandbox, and closing it discards everything inside.
        await stopWindowsSandbox();
        stopped.push(...runs.filter((run) => run.isolated === true).map((run) => run.name));
    }
    for (const run of runs.filter((each) => each.isolated !== true)) {
        // one at a time: each waits out its own grace, and a tree stopped together reads apart in the narration
        const outcome = await stopOne(run).catch((error: Error) => error.message);
        if (outcome === "stopped") {
            stopped.push(run.name);
        } else if (outcome !== "ended") {
            left.push({ run, why: outcome });
        }
    }
    return { stopped, left };
};
