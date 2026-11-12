import { basename } from "node:path";
import type { PressureRelief } from "../../../system/resources/storage/disk-pressure.js";
import { sameFilesystem } from "../../../system/resources/storage/pressure-reliefs.js";
import { readRunningPrograms, type RunningProgram } from "../../../system/resources/storage/running-programs.js";
import { pruneBuildOutputs, removeQuietly } from "./build-outputs.js";

// A build in flight, by the program's own name: Cargo, or rustc however it was wrapped (sccache, the rustc-cached shim).
const COMPILERS = new Set(["cargo", "rustc"]);
export const rustBuildRunning = (programs: readonly RunningProgram[]): boolean =>
    programs.some((program) => program.argv.slice(0, 3).some((arg) => COMPILERS.has(basename(arg))));

export interface MainIncrementalDeps {
    readonly workspaceRoot: string;
    readonly historyRoot: string;
    readonly programs?: () => Promise<readonly RunningProgram[]>;
    readonly remove?: (path: string) => Promise<void>;
}

// THE MAIN CHECKOUT'S OWN INCREMENTAL CACHES (2026-11-12). Settled checkouts lose their `incremental/` an hour after they
// go quiet (build-outputs.ts); the main checkout never did, and on shinobi its seven build profiles held 68 GB of it,
// more than every checkout's build output together. A disk-pressure relief (disk-pressure.ts PressureRelief), taken
// only while no Cargo or rustc runs anywhere: a namespace's `/work` and the main one read the same in procfs, so a build
// cannot be placed, and one losing its session directory mid-compile fails. The watch looks again a minute later,
// between builds. Only where the workspace shares the history volume's filesystem: freeing a separate disk gives the
// history volume nothing.
export const mainIncrementalRelief = (deps: MainIncrementalDeps): PressureRelief => ({
    name: "main checkout's Cargo incremental caches",
    free: async (enough) => {
        if (!(await sameFilesystem(deps.workspaceRoot, deps.historyRoot)) || rustBuildRunning(await (deps.programs ?? readRunningPrograms)())) {
            return 0;
        }
        let roomy = false;
        const remove = deps.remove ?? removeQuietly;
        const pruned = await pruneBuildOutputs(deps.workspaceRoot, {
            scope: "incremental",
            proceed: () => !roomy,
            remove: async (path) => {
                await remove(path);
                roomy = await enough();
            },
        });
        return pruned.removed.length;
    },
});
