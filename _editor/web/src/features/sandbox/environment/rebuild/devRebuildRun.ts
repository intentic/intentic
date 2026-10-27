import type { DevRebuildLog, DevRebuildTasks } from "@intentic/sandbox-contract/schemas/devices";
import type { DevRebuildLayers, DevRebuildStage } from "./devRebuildStages";

// WHAT IS KNOWN OF ONE REBUILD, as useDevRebuild keeps it per slug: its phase on this page, what the machine's log last
// said, and what the card draws from both. Its own file so the follower is the polling and nothing else.

export type DevRebuildPhase =
    // Nothing known: no rebuild started here, and the machine's log is old or absent.
    | "idle"
    // The command that starts the build is in flight; seconds, not minutes.
    | "starting"
    | "building"
    // The daemon stopped answering, which mid-build is the swap onto the new image rather than a fault.
    | "restarting"
    | "done"
    | "failed"
    // Stopped because somebody asked (`dev-rebuild-cancel`), before the swap: the sandbox never left its old image.
    | "cancelled"
    // The log stopped growing and never said how it ended: a machine that slept, or a build someone killed.
    | "lost";

export interface DevRebuildRun {
    phase: DevRebuildPhase;
    // When the build began, by this browser's clock. Undefined for a rebuild found already running on the machine: its
    // log says when it last printed, never when it started, and a clock started at the wrong moment is worse than none.
    startedAt: number | undefined;
    endedAt: number | undefined;
    /** The machine's log tail, replaced whole on each read rather than accumulated. */
    lines: readonly string[];
    exitCode: number | undefined;
    /** Seconds since the log last grew; a build inside a slow docker layer is quiet for minutes at a time. */
    quietFor: number | undefined;
    /** The machine's own sentence when it refused, or why this browser cannot read the log at the moment. */
    trouble: string | undefined;
    // When the log was last READ, which is a fact about this browser's contact with the machine and not about the
    // build: it is what the follow gives up on, since a read that keeps failing leaves `quietFor` frozen at whatever
    // the last good read said. Set when a follow begins as well as on every read, so contact is dated from the moment
    // this browser started asking rather than from a marker that may be an hour old — except in the restart step,
    // whose silence is the sandbox's own and is carried across a reload (see `restartKey`).
    heardAt: number | undefined;
    /** A `lost` run ended by nothing being heard for the silence ceiling, rather than by anything the machine said. */
    unheard: boolean;
    /** Which of the three things a rebuild does it is on. Only ever advances: see devRebuildStages.ts. */
    stage: DevRebuildStage;
    /** When each stage was first seen, so the card can time a step it watched begin. */
    stageAt: Partial<Record<DevRebuildStage, number>>;
    /** The stage's own last word — the package turbo is on, the sentence ic printed. */
    detail: string | undefined;
    /** Docker's step counter, the one real fraction inside the longest stage. */
    layers: DevRebuildLayers | undefined;
    /**
     * How far along, 0–1, never decreasing: a tail that scrolls must not walk the bar backwards. The one way back is a
     * restart step a log then shows was only assumed (`settleAssumption`).
     */
    fraction: number;
    /**
     * The restart step taken from the daemon going quiet (`unread`) before any log showed it. The next log that lands
     * settles it (`settleAssumption`): confirmed where it shows the swap, and otherwise the run goes back to its build.
     */
    swapAssumed: boolean;
    /** Whether the swap gate's hold file is there, so the restart waits to be let through; undefined from an older daemon. */
    hold: boolean | undefined;
    /** The gate is holding now: built, the container untouched, the restart waiting on the owner or an idle fleet. */
    waiting: boolean;
    /** The gate let the swap through, and from here nothing may stop the build. */
    swapping: boolean;
    /** Turbo's tasks started, counted over the whole log, and its total once it has said it. */
    tasks: DevRebuildTasks | undefined;
    /** When the gate began holding, while it holds. */
    waitingSince: number | undefined;
    /** Time already spent held, so a step's clock and the next run's measure leave the owner's wait out. */
    waitedMs: number;
}

const LIVE: ReadonlySet<DevRebuildPhase> = new Set(["starting", "building", "restarting"]);
export const rebuildRunning = (phase: DevRebuildPhase): boolean => LIVE.has(phase);

/** A run that has not begun, or one cleared off the card. */
export const idleRun = (): DevRebuildRun => ({
    phase: "idle",
    startedAt: undefined,
    endedAt: undefined,
    lines: [],
    exitCode: undefined,
    quietFor: undefined,
    trouble: undefined,
    heardAt: undefined,
    unheard: false,
    stage: "compile",
    stageAt: {},
    detail: undefined,
    layers: undefined,
    fraction: 0,
    swapAssumed: false,
    hold: undefined,
    waiting: false,
    swapping: false,
    tasks: undefined,
    waitingSince: undefined,
    waitedMs: 0,
});

// For an older daemon's read: how recently the log must have grown for a rebuild nobody here started to be adopted.
const ADOPT_WITHIN_S = 120;

// WHETHER THE MACHINE HAS A REBUILD GOING, by the guard's own test where the daemon reports it: the process is alive. A
// build held at its swap gate prints nothing for as long as it is held, and a hung docker layer prints nothing for days,
// yet both still block the next rebuild; going by the log's silence alone dropped such a build off the card while the
// guard went on refusing every new one (rog, 2026-10-27). Only an older daemon, which cannot say, leaves it to the log:
// a gate holding, or a log that grew in the last couple of minutes.
export const liveOnMachine = (log: DevRebuildLog): boolean => {
    if (log.missing || log.exitCode !== undefined) {
        return false;
    }
    return log.alive ?? (log.waiting || (log.quietFor !== undefined && log.quietFor <= ADOPT_WITHIN_S));
};
