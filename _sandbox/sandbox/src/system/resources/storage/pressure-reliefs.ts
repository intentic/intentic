import { stat } from "node:fs/promises";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { PressureRelief } from "./disk-pressure.js";
import { readRunningPrograms, type RunningProgram } from "./running-programs.js";
import { expireCategory } from "./storage-clean.js";
import type { StorageRoots } from "./storage-catalog.js";

// What the disk-pressure watch may take once settled checkouts' build output is gone (disk-pressure.ts PressureRelief):
// the turns' leftovers here; the main checkout's Cargo incremental caches, a checkout matter, in
// conversations/worktrees/build-outputs/main-incremental.ts.

const DAY_MS = 24 * 60 * 60 * 1000;

// Captures and artifacts this old have had their turn: the conversation that made them has long read them back.
export const LEFTOVERS_KEEP_MS = 7 * DAY_MS;

// Whether freeing the workspace volume gives the history volume room: true where both are folders of one filesystem
// (a local engine's volumes, a hosted machine's one volume), false where they are separate disks or one is missing.
export const sameFilesystem = async (left: string, right: string): Promise<boolean> => {
    const [a, b] = await Promise.all([stat(left).catch(undefinedIfMissing), stat(right).catch(undefinedIfMissing)]);
    return a !== undefined && b !== undefined && a.dev === b.dev;
};

export interface LeftoversDeps {
    readonly roots: () => Promise<StorageRoots>;
    readonly historyRoot: string;
    readonly programs?: () => Promise<readonly RunningProgram[]>;
    readonly now: () => number;
}

// Browser captures, then other artifacts, untouched for a week, oldest first, by the Storage cleaner's own rules (in use
// or protected stays). Browser captures go first: nothing reads one after the turn that took it. On shinobi, 56 GB of
// artifacts (37 GB of motion-capture frame dumps, 3-11 days old) sat beside a full disk the watch could not touch.
export const leftoversRelief = (deps: LeftoversDeps): PressureRelief => ({
    name: "week-old browser captures and artifacts",
    free: async (enough) => {
        const roots = await deps.roots();
        if (!(await sameFilesystem(roots.workspace, deps.historyRoot))) {
            return 0;
        }
        const clean = { roots, now: deps.now, programs: deps.programs ?? readRunningPrograms, prune: async () => false };
        let removed = 0;
        for (const category of ["browserCaptures", "artifacts"] as const) {
            if (await enough()) {
                break;
            }
            removed += (await expireCategory(category, clean, LEFTOVERS_KEEP_MS, enough)).removed;
        }
        return removed;
    },
});
