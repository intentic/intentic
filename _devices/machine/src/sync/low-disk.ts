import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { errnoCode } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { isProjectPairing, type LowDiskReading, type Pairing, pairingKey, projectDirection, setLowDisk } from "./config.js";

// THE DRIVE A FOLDER SYNCS ONTO HAS A FLOOR (2026-10-18). Nothing on this side ever asked how much room was left: a
// laptop whose drive filled with what this agent wrote kept receiving until every write on it failed, the owner's own
// programs' included, and freeing a gigabyte bought minutes. Now a pairing's file sync and git bridge hold still while
// the drive holding its folder is under its floor, and carry on once the floor and a margin are free again, so freeing
// a little does not start it all over at once. This only keeps the fact (`lowDisk`); holds.ts holds the sync for it. The floor is 2% of the drive, never under 5 GiB (a small drive still keeps
// room for the system) and never over 20 GiB (a large one is not paused with tens of GB free).

const GIB = 1024 ** 3;
const FLOOR_SHARE = 0.02;
export const FLOOR_MIN_BYTES = 5 * GIB;
export const FLOOR_MAX_BYTES = 20 * GIB;
export const RESUME_MARGIN_BYTES = 2 * GIB;

export interface DiskReading {
    readonly freeBytes: number;
    readonly totalBytes: number;
}

export const diskFloor = (totalBytes: number): number => Math.min(Math.max(totalBytes * FLOOR_SHARE, FLOOR_MIN_BYTES), FLOOR_MAX_BYTES);

export type LowDiskStep = "pause" | "resume" | "hold" | "none";

// What a pass does about the drive: hold a pairing under the floor, let one held for it go once the floor and margin
// are free, keep one still short held, and otherwise nothing. A drive that could not be measured is not known to be
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

const gigabytes = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GB`;

// Measures one pairing's drive and keeps the fact; answers whether it is held for the drive after this pass.
const guardOne = async (
    read: (dir: string) => Promise<DiskReading | undefined>,
    pairing: Pairing & { readonly localDir: string },
    say: Log,
    record: (key: string, reading: LowDiskReading | undefined) => Promise<void>,
): Promise<boolean> => {
    const key = pairingKey(pairing);
    const reading = await read(pairing.localDir);
    const step = lowDiskStep(reading, pairing.lowDisk !== undefined);
    if (step === "pause" && reading !== undefined) {
        await record(key, { since: Date.now(), ...reading });
        say(
            `  ${key}: the drive holding ${pairing.localDir} has ${gigabytes(reading.freeBytes)} free, under its floor of ${gigabytes(diskFloor(reading.totalBytes))}; file sync and the git bridge hold still until it has room again.`,
        );
        return true;
    }
    if (step === "resume" && reading !== undefined) {
        await record(key, undefined);
        say(`  ${key}: the drive holding ${pairing.localDir} has ${gigabytes(reading.freeBytes)} free again; file sync and the git bridge carry on.`);
        return false;
    }
    return step === "hold";
};

// One pass over every pairing that writes here, answering the keys held for want of room, whose git bridge waits.
// `read` and `record` are the drive and the pairing's record, injectable so the rule is checked without either.
export const guardDisks = async (
    pairings: readonly Pairing[],
    say: Log,
    read: (dir: string) => Promise<DiskReading | undefined> = readDisk,
    record: (key: string, reading: LowDiskReading | undefined) => Promise<void> = setLowDisk,
): Promise<ReadonlySet<string>> => {
    const held = new Set<string>();
    for (const pairing of pairings.filter(writesToDisk)) {
        // one statfs each, in order, as every pass here
        if (await guardOne(read, pairing, say, record)) {
            held.add(pairingKey(pairing));
        }
    }
    return held;
};
