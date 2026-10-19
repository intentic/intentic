import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { errnoCode } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { isProjectPairing, type LowDiskPause, type Pairing, pairingKey, projectDirection, setFileSyncLowDisk } from "./config.js";
import { pauseRunningSessions, resumeNamedSessions, resumeWatcherPausedSync } from "./mutagen.js";

// THE DRIVE A FOLDER SYNCS ONTO HAS A FLOOR (2026-10-18). Nothing on this side ever asked how much room was left: a
// laptop whose drive filled with what this agent wrote kept receiving until every write on it failed, the owner's own
// programs' included, and freeing a gigabyte bought minutes. Now a pairing's file sync and git bridge pause while the
// drive holding its folder is under its floor, and resume once the floor and a margin are free again, so freeing a
// little does not start it all over at once. The floor is 2% of the drive, never under 5 GiB (a small drive still keeps
// room for the system) and never over 20 GiB (a large one is not paused with tens of GB free).

const GIB = 1024 ** 3;
const FLOOR_SHARE = 0.02;
export const FLOOR_MIN_BYTES = 5 * GIB;
export const FLOOR_MAX_BYTES = 20 * GIB;
export const RESUME_MARGIN_BYTES = 2 * GIB;

// While paused, the pause is put back this often (in watcher ticks): another pause's lifting (the sandbox answering
// again, a swap settling) resumes every session the pairing has, whatever else still holds it.
const REASSERT_EVERY_TICKS = 12;

export interface DiskReading {
    readonly freeBytes: number;
    readonly totalBytes: number;
}

export const diskFloor = (totalBytes: number): number => Math.min(Math.max(totalBytes * FLOOR_SHARE, FLOOR_MIN_BYTES), FLOOR_MAX_BYTES);

export type LowDiskStep = "pause" | "resume" | "hold" | "none";

// What a pass does about the drive: pause a pairing under the floor, resume one paused for it once the floor and margin
// are free, keep one still short paused, and otherwise nothing. A drive that could not be measured is not known to be
// full, so it pauses nothing, and lifts nothing either.
export const lowDiskStep = (reading: DiskReading | undefined, paused: boolean): LowDiskStep => {
    if (reading === undefined) {
        return paused ? "hold" : "none";
    }
    const floor = diskFloor(reading.totalBytes);
    if (!paused) {
        return reading.freeBytes < floor ? "pause" : "none";
    }
    return reading.freeBytes >= floor + RESUME_MARGIN_BYTES ? "resume" : "hold";
};

// The drive holding `dir`, read at the nearest folder that exists: a folder setup has not made yet, or one the owner
// deleted, sits on its parent's drive.
export const readDisk = async (dir: string): Promise<DiskReading | undefined> => {
    for (let at = dir; ; at = dirname(at)) {
        try {
            // walks up only as far as the first folder that exists
            const stats = await statfs(at);
            return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
        } catch (error) {
            if (errnoCode(error) !== "ENOENT" || dirname(at) === at) {
                return undefined;
            }
        }
    }
};

// The pairings whose sessions write into this machine's folder. A copy-first project only sends: what reaches its folder
// comes by Bring back, never by its session, so a full drive has nothing to stop there.
export const writesToDisk = (pairing: Pairing): pairing is Pairing & { readonly localDir: string } =>
    pairing.mode === "sync" &&
    pairing.localDir !== undefined &&
    pairing.projectsHost !== true &&
    !(isProjectPairing(pairing) && projectDirection(pairing) === "to-sandbox");

// Whether some other pause of the watcher's still holds this pairing, which the low-disk lifting must leave to its owner.
const otherwiseHeld = (pairing: Pairing): boolean =>
    pairing.fileSyncAutoPaused === true || pairing.fileSyncSwapPaused === true || pairing.fileSyncPausedFor !== undefined;

const gigabytes = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GB`;

// What the guard acts through: the drive's reading, Mutagen's pause and resume, and the pairing's record. Injectable so
// which sessions a lift resumes is checkable without a Mutagen daemon.
export interface LowDiskSeams {
    readonly read: (dir: string) => Promise<DiskReading | undefined>;
    // Pauses the running sessions and answers which (undefined: Mutagen did not answer).
    readonly pause: (pairing: Pairing) => readonly string[] | undefined;
    // Each answers whether the resume took (mutagen.ts `resumeSessions`).
    readonly resume: (names: readonly string[]) => Promise<boolean>;
    // Every session of the pairing, for a record from before the pause kept its own list.
    readonly resumeAll: (pairing: Pairing) => Promise<boolean>;
    readonly record: (key: string, pause: LowDiskPause | undefined) => Promise<void>;
}

const mutagenSeams = (mutagen: string): LowDiskSeams => ({
    read: readDisk,
    pause: (pairing) => pauseRunningSessions(mutagen, pairing),
    resume: async (names) => await resumeNamedSessions(mutagen, names),
    resumeAll: async (pairing) => await resumeWatcherPausedSync(mutagen, pairing),
    record: setFileSyncLowDisk,
});

// Measures, and acts for, one pairing; answers whether it is held for the drive after this pass. The pause keeps the
// names of the sessions it paused, and its lifting resumes those alone: a session the owner had paused by hand was not
// running when the drive filled, so it stays paused once the drive has room.
const guardOne = async (seams: LowDiskSeams, pairing: Pairing & { readonly localDir: string }, tick: number, say: Log): Promise<boolean> => {
    const key = pairingKey(pairing);
    const reading = await seams.read(pairing.localDir);
    const held = pairing.fileSyncLowDisk;
    const step = lowDiskStep(reading, held !== undefined);
    if (step === "pause" && reading !== undefined) {
        // A Mutagen that did not answer paused nothing yet; the reassertion below pauses and lists them.
        const paused = seams.pause(pairing) ?? [];
        await seams.record(key, { since: Date.now(), ...reading, paused });
        say(
            `  ${key}: the drive holding ${pairing.localDir} has ${gigabytes(reading.freeBytes)} free, under its floor of ${gigabytes(diskFloor(reading.totalBytes))}; paused file sync and the git bridge until it has room again.`,
        );
        return true;
    }
    if (step === "resume" && reading !== undefined) {
        const lifted = { ...pairing, fileSyncLowDisk: undefined };
        // Another pause still holding the pairing resumes it when that pause lifts. Otherwise this one resumes what it
        // paused, and (2026-10-19) keeps its record until Mutagen took that, so a resume that did not is tried again
        // next pass rather than leaving the sync paused with no record to lift.
        const resumed = otherwiseHeld(lifted) || (held?.paused === undefined ? await seams.resumeAll(lifted) : await seams.resume(held.paused));
        if (!resumed) {
            say(`  ${key}: the drive holding ${pairing.localDir} has room again, but Mutagen did not take the resume of its file sync; trying again.`);
            return true;
        }
        await seams.record(key, undefined);
        say(`  ${key}: the drive holding ${pairing.localDir} has ${gigabytes(reading.freeBytes)} free again; file sync and the git bridge carry on.`);
        return false;
    }
    if (step === "hold") {
        // Put back what was resumed meanwhile (another pause's lifting, the owner by hand, a session made since), and
        // added to the list: it was running, so it runs again once the drive has room.
        if (tick % REASSERT_EVERY_TICKS === 0 && held !== undefined) {
            const added = (seams.pause(pairing) ?? []).filter((name) => held.paused?.includes(name) !== true);
            if (added.length > 0 && held.paused !== undefined) {
                await seams.record(key, { ...held, paused: [...held.paused, ...added] });
            }
        }
        return true;
    }
    return false;
};

// One pass over every pairing that writes here, answering the keys held for want of room: their git bridge waits, and
// no other pause's lifting resumes them this pass.
export const guardDisks = async (
    mutagen: string,
    pairings: readonly Pairing[],
    tick: number,
    say: Log,
    seams: LowDiskSeams = mutagenSeams(mutagen),
): Promise<ReadonlySet<string>> => {
    const held = new Set<string>();
    for (const pairing of pairings.filter(writesToDisk)) {
        // one statfs each, in order, as every pass here
        if (await guardOne(seams, pairing, tick, say)) {
            held.add(pairingKey(pairing));
        }
    }
    return held;
};
