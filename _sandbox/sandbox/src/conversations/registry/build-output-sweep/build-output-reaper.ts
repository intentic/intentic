import { join, relative, sep } from "node:path";
import {
    type AgentArchiveDeps,
    type BuildOutputQuiet,
    buildOutputsReapable,
    NO_QUIET,
    NORMAL_QUIET,
    type PrunedAt,
    reapOneBuildOutput,
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
    // The settled checkouts whose quiet time has passed (landed ones after an hour, the rest after the settings' idle
    // hours), and the incremental caches of those settled an hour.
    readonly sweep: (now: number) => Promise<SweptCheckout[]>;
    // Every settled checkout now, landed first then the longest idle, until `enough` says the disk has room again.
    readonly reapUnderPressure: (now: number, enough: () => Promise<boolean>) => Promise<SweptCheckout[]>;
    // A person's press: every settled checkout now, whatever an earlier pass remembers.
    readonly reapAll: (now: number) => Promise<SweptCheckout[]>;
    // A person's press on one conversation's row; throws CheckoutBusy when something runs in it.
    readonly reapOne: (id: string) => Promise<SweptCheckout>;
    // Whether the build output at this path (inside a conversation's checkout) may be removed now.
    readonly reapable: (path: string, now: number) => boolean;
}

export interface BuildOutputReaperDeps {
    // The registry, conversations and worktrees the sweep reads (the composition's services, as archive.ts takes them).
    readonly archive: AgentArchiveDeps;
    readonly worktreesRoot: string;
    // Where conversations' overlay layers are (isolation.ts overlaysRoot): a shared Cargo target's writes live there
    // (cargo-warm.ts). Absent, only the checkouts themselves are swept.
    readonly overlaysRoot?: string;
    readonly runningJobs: RunningJobs;
    // The hourly sweep's clock, read each pass so a changed setting holds from the next one (archive.ts quietOfSettings).
    readonly quiet?: () => Promise<BuildOutputQuiet>;
    readonly remove?: (path: string) => Promise<void>;
}

export const createBuildOutputReaper = (deps: BuildOutputReaperDeps): BuildOutputReaper => {
    // Which checkouts were already emptied at which card state, for the daemon's life (archive.ts PrunedAt).
    const prunedAt: PrunedAt = new Map();
    const remove = deps.remove ?? removeQuietly;
    const { overlaysRoot } = deps;
    const overlaysOf = overlaysRoot === undefined ? undefined : (id: string) => join(overlaysRoot, id);
    const layers = overlaysOf === undefined ? {} : { overlaysOf };
    // The conversation a path inside one of its checkouts or overlay layers belongs to.
    const ownerOf = (path: string): string | undefined => {
        for (const root of [deps.worktreesRoot, ...(overlaysRoot === undefined ? [] : [overlaysRoot])]) {
            const rel = relative(root, path);
            const id = rel.split(sep)[0];
            if (id !== undefined && id !== "" && id !== ".." && !rel.startsWith(`..${sep}`)) {
                return id;
            }
        }
        return undefined;
    };
    return {
        sweep: async (now) =>
            sweepBuildOutputs(deps.archive, {
                now,
                quiet: (await deps.quiet?.()) ?? NORMAL_QUIET,
                runningJobs: deps.runningJobs,
                prunedAt,
                paceMs: PACE_MS,
                remove,
                ...layers,
            }),
        reapUnderPressure: (now, enough) =>
            sweepBuildOutputs(deps.archive, { now, quiet: NO_QUIET, runningJobs: deps.runningJobs, prunedAt, paceMs: PRESSED_PACE_MS, enough, remove, ...layers }),
        reapAll: (now) =>
            sweepBuildOutputs(deps.archive, { now, quiet: NO_QUIET, runningJobs: deps.runningJobs, prunedAt: new Map(), paceMs: PRESSED_PACE_MS, remove, ...layers }),
        reapOne: (id) => reapOneBuildOutput(deps.archive, deps.runningJobs, id, remove, overlaysOf),
        reapable: (path, now) => {
            const id = ownerOf(path);
            if (id === undefined) {
                return false;
            }
            const agent = deps.archive.agents.list().find((card) => card.id === id);
            return agent !== undefined && buildOutputsReapable(deps.archive, deps.runningJobs, agent, now);
        },
    };
};

