import { rm } from "node:fs/promises";
import { writeFileAtomic } from "@intentic/base/fs";
import { mirrorHeartbeatPath } from "./config.js";

/* THE SYNC LOOP'S PULSE, as every report reads it (`lastTickAt`, judged by the contract's `agentStalled`).

   Stamped as the loop MOVES, not only once a whole pass is done (2026-10-21). A pass is many bounded steps (ports, the
   transports, a Mutagen session create of up to five minutes, one sandbox after another), and a pass against one slow
   sandbox is healthy all the while it takes; stamped only at its end, the stamp aged past the verdict's deadline on a
   loop that was working. Moving is also what the loop's own stall check measures (mirror.ts), so the stamp and the
   restart now speak about the same thing.

   Removed when the loop ends on purpose, its last pairing gone: no loop is owed then, and a stamp left behind read as a
   loop that had stopped, "Agent stalled" on the Devices page for as long as the agent ran. The report also leaves the
   stamp out while nothing is paired (report.ts), which covers one an agent that died left behind. */

// At most one write per this, however many steps a pass marks: far inside any deadline that reads it.
const BEAT_EVERY_MS = 5_000;

// The write in flight, so the stop below lands after it rather than under it.
let writing: Promise<void> = Promise.resolve();

// A failed write must not stop mirroring, so it silently under-claims.
// allow(silent-catch): a stamp that could not be written reads as stale, which `intentic-machine status` already reports.
const stamp = async (at: number): Promise<void> => await writeFileAtomic(mirrorHeartbeatPath, String(at)).catch(() => {});

/** The pulse of one run of the loop, called on every step it marks; it writes when the last write is old enough. */
export interface Heartbeat {
    readonly moved: () => void;
}

export const createHeartbeat = (now: () => number = Date.now): Heartbeat => {
    let last = Number.NEGATIVE_INFINITY;
    return {
        moved: () => {
            const at = now();
            if (at - last < BEAT_EVERY_MS) {
                return;
            }
            last = at;
            // The step goes on whether or not its stamp landed; `stamp` swallows its own failure.
            writing = stamp(at);
        },
    };
};

// The loop ended because nothing is paired any more: no pulse is owed, so none is left to be read as a stopped one.
export const stopHeartbeat = async (): Promise<void> => {
    await writing;
    // allow(silent-catch): a stamp that could not be removed is left out of the report anyway while nothing is paired.
    await rm(mirrorHeartbeatPath, { force: true }).catch(() => {});
};
