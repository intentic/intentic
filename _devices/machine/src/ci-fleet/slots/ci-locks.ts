import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FleetSys } from "../sys.js";

/* WHICH SLOTS SOMEONE ELSE HOLDS, read without touching a lock: trying one would take it from a job for that instant.
   Two readings, joined. /proc/locks names every flock by device and inode, but outside the host's first pid namespace
   (a WSL distro, omen) it leaves out a lock whose taker has exited, and test-memory-pool.mjs takes its locks with
   flock(1), which exits at once. /proc/<pid>/fdinfo/<fd> still shows such a lock on the descriptor that carries it, so
   the open slot files of every process this one can see are read too. Neither sees a process of another pid namespace
   holding the file open (a job in a Docker Desktop container on omen). */

// A slot file as /proc/locks names it: "major:minor:inode", the device numbers in decimal.
export type FileKey = string;

const fileKey = (major: number, minor: number, inode: bigint | string): FileKey => `${major}:${minor}:${inode}`;

// The kernel's split of a stat dev_t into major and minor (new_decode_dev), on bigints since a dev_t is 64 bits.
const decodeDev = (dev: bigint) => ({
    major: Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn)),
    minor: Number((dev & 0xffn) | ((dev >> 12n) & ~0xffn)),
});

// The files of slots 1..total by their key, for those that exist.
export const slotFileKeys = async (dir: string, total: number): Promise<Map<FileKey, number>> => {
    const keys = new Map<FileKey, number>();
    for (let slot = 1; slot <= total; slot += 1) {
        try {
            // one stat each, 16 at most
            const info = await stat(join(dir, `slot-${slot}`), { bigint: true });
            const { major, minor } = decodeDev(info.dev);
            keys.set(fileKey(major, minor, info.ino), slot);
        } catch {
            // allow(silent-catch): a slot file nobody has made yet is a slot nobody holds
        }
    }
    return keys;
};

// The files /proc/locks says carry a flock now. A waiter's line ("1: -> FLOCK …") is a lock not yet had, so it is left out.
export const flockedFiles = (procLocks: string): Set<FileKey> => {
    const files = new Set<FileKey>();
    for (const line of procLocks.split("\n")) {
        const match = /^\d+:\s+FLOCK\s+\S+\s+\S+\s+-?\d+\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/iu.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
            files.add(fileKey(Number.parseInt(match[1], 16), Number.parseInt(match[2], 16), match[3]));
        }
    }
    return files;
};

// Whether an fdinfo says its descriptor carries a flock.
export const fdinfoFlocked = (fdinfo: string): boolean => /^lock:\s+\d+:\s+FLOCK\s/mu.test(fdinfo);

const fdsOf = async (sys: FleetSys, pid: string): Promise<string[]> => (await sys.list(`/proc/${pid}/fd`)) ?? [];

// The slots some process this one can see holds a flock on through an open descriptor.
const fdinfoSlots = async (sys: FleetSys, slotPaths: ReadonlyMap<string, number>): Promise<Set<number>> => {
    const slots = new Set<number>();
    const pids = ((await sys.list("/proc")) ?? []).filter((name) => /^\d+$/u.test(name));
    for (const pid of pids) {
        for (const fd of await fdsOf(sys, pid)) {
            const slot = slotPaths.get((await sys.readLink(`/proc/${pid}/fd/${fd}`)) ?? "");
            if (slot !== undefined && !slots.has(slot) && fdinfoFlocked((await sys.readText(`/proc/${pid}/fdinfo/${fd}`)) ?? "")) {
                slots.add(slot);
            }
        }
    }
    return slots;
};

// The slots held now by anyone, this service's own children included: the caller takes those out.
export const lockedSlots = async (sys: FleetSys, dir: string, total: number): Promise<Set<number>> => {
    const keys = await slotFileKeys(dir, total);
    const locked = new Set<number>();
    for (const key of flockedFiles((await sys.readText("/proc/locks")) ?? "")) {
        const slot = keys.get(key);
        if (slot !== undefined) {
            locked.add(slot);
        }
    }
    // A descriptor's link names the file by its real path, so a slot folder reached through a symlink is resolved first.
    const real = await realpath(dir).catch(() => dir);
    const paths = new Map(Array.from({ length: total }, (_, index) => [join(real, `slot-${index + 1}`), index + 1] as const));
    for (const slot of await fdinfoSlots(sys, paths)) {
        locked.add(slot);
    }
    return locked;
};
