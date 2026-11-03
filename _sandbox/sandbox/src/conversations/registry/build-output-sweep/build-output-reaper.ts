import { relative, sep } from "node:path";
import {
    type AgentArchiveDeps,
    buildOutputsReapable,
    NO_QUIET,
    NORMAL_QUIET,
    type PrunedAt,
    type RunningJobs,
    type SweptCheckout,
    sweepBuildOutputs,
} from "../archive.js";
import { removeQuietly } from "../../worktrees/build-outputs/build-outputs.js";

// The one door to removing build output from conversation checkouts (worktrees/build-outputs/build-outputs.ts says what counts as one): the
// hourly sweep, the disk-pressure watch and the Storage card's Clean press all go through it, so they share one memory
// of which checkout was already emptied and one rule for which may be.

// A big sweep's IO spread out: a pause between folders when nothing is short, almost none when the disk is.
const PACE_MS = 2000;
const PRESSED_PACE_MS = 200;

export interface BuildOutputReaper {
    // The settled checkouts whose quiet time has passed (landed ones after an hour, the rest after six).
    readonly sweep: (now: number) => Promise<SweptCheckout[]>;
    // Every settled checkout now, landed first then the longest idle, until `enough` says the disk has room again.
    readonly reapUnderPressure: (now: number, enough: () => Promise<boolean>) => Promise<SweptCheckout[]>;
    // A person's press: every settled checkout now, whatever an earlier pass remembers.
    readonly reapAll: (now: number) => Promise<SweptCheckout[]>;
    // Whether the build output at this path (inside a conversation's checkout) may be removed now.
    readonly reapable: (path: string, now: number) => boolean;
}

export interface BuildOutputReaperDeps {
    // The registry, conversations and worktrees the sweep reads (the composition's services, as archive.ts takes them).
    readonly archive: AgentArchiveDeps;
    readonly worktreesRoot: string;
    readonly runningJobs: RunningJobs;
    readonly remove?: (path: string) => Promise<void>;
}

export const createBuildOutputReaper = (deps: BuildOutputReaperDeps): BuildOutputReaper => {
    // Which checkouts were already emptied at which card state, for the daemon's life (archive.ts PrunedAt).
    const prunedAt: PrunedAt = new Map();
    const remove = deps.remove ?? removeQuietly;
    return {
        sweep: (now) => sweepBuildOutputs(deps.archive, { now, quiet: NORMAL_QUIET, runningJobs: deps.runningJobs, prunedAt, paceMs: PACE_MS, remove }),
        reapUnderPressure: (now, enough) =>
            sweepBuildOutputs(deps.archive, { now, quiet: NO_QUIET, runningJobs: deps.runningJobs, prunedAt, paceMs: PRESSED_PACE_MS, enough, remove }),
        reapAll: (now) => sweepBuildOutputs(deps.archive, { now, quiet: NO_QUIET, runningJobs: deps.runningJobs, prunedAt: new Map(), paceMs: PRESSED_PACE_MS, remove }),
        reapable: (path, now) => {
            const rel = relative(deps.worktreesRoot, path);
            const id = rel.split(sep)[0];
            if (id === undefined || id === "" || id === ".." || rel.startsWith(`..${sep}`)) {
                return false;
            }
            const agent = deps.archive.agents.list().find((card) => card.id === id);
            return agent !== undefined && buildOutputsReapable(deps.archive, deps.runningJobs, agent, now);
        },
    };
};

