import type { StatsFs } from "node:fs";
import { readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { checkoutSpace, CheckoutSpaceRefused, hostDriveCritical, type HistorySpace } from "./checkout-space.js";

const HOST_DISK_HINT_MAX_AGE_MS = 30 * 60_000;
const HOST_DISK_HINT_CACHE_MS = 3_000;
const HostEngineSchema = z.enum(["intentic", "dockerDesktop", "own"]);
const HostDiskHintSchema = z.object({
    v: z.literal(1),
    at: z.number().int().nonnegative(),
    engine: HostEngineSchema,
    drive: z.string().min(1),
    driveFreeBytes: z.number().int().nonnegative(),
    driveTotalBytes: z.number().int().nonnegative(),
    backingPath: z.string().min(1),
    backingBytes: z.number().int().nonnegative(),
});
type HostDiskHint = z.infer<typeof HostDiskHintSchema>;

interface CachedHostDiskHint {
    readonly until: number;
    readonly read: Promise<HostDiskHint | undefined>;
}

const hostDiskHints = new Map<string, CachedHostDiskHint>();

const readHostDiskHint = (engine: string, directory: string, now: number): Promise<HostDiskHint | undefined> => {
    const key = `${engine}\0${directory}`;
    const cached = hostDiskHints.get(key);
    if (cached !== undefined && now < cached.until) {
        return cached.read;
    }
    const read = readFile(join(directory, `disk-${engine}.json`), "utf8")
        .then((contents) => HostDiskHintSchema.safeParse(JSON.parse(contents)))
        .then((parsed) => {
            if (!parsed.success || parsed.data.engine !== engine || now - parsed.data.at > HOST_DISK_HINT_MAX_AGE_MS) {
                return undefined;
            }
            return parsed.data;
        })
        // allow(silent-catch): host hints are optional; missing, unreadable, or malformed hints preserve the statfs reading.
        .catch(() => undefined);
    hostDiskHints.set(key, { until: now + HOST_DISK_HINT_CACHE_MS, read });
    return read;
};

// Pure clamp for the dense VHDX on its host drive: existing backing-file blocks can be reused before the file grows.
export const limitHistorySpaceByHostDisk = (space: HistorySpace, hint: HostDiskHint): HistorySpace => {
    const used = space.totalBytes - space.freeBytes;
    const hostRoom = hint.driveFreeBytes + Math.max(0, hint.backingBytes - used);
    const freeBytes = Math.min(space.freeBytes, hostRoom);
    if (hostRoom >= space.freeBytes) {
        return space;
    }
    return {
        freeBytes,
        totalBytes: used + freeBytes,
        limitedBy: { drive: hint.drive, driveFreeBytes: hint.driveFreeBytes },
    };
};

// Root's writes may fill the reserved blocks an unprivileged writer is kept out of (checkout-space.ts).
export const readHistorySpace = async (
    root: string,
    privileged = process.geteuid?.() === 0,
    readVolume: (root: string) => Promise<StatsFs> = statfs,
): Promise<HistorySpace> => {
    const volume = await readVolume(root);
    const space: HistorySpace = {
        freeBytes: (privileged ? volume.bfree : volume.bavail) * volume.bsize,
        totalBytes: volume.blocks * volume.bsize,
    };
    const engine = process.env["HOST_ENGINE"];
    if (engine === undefined || !HostEngineSchema.safeParse(engine).success) {
        return space;
    }
    const hint = await readHostDiskHint(engine, process.env["INTENTIC_HOST_DISK_DIR"] ?? "/run/intentic/host", Date.now());
    return hint === undefined ? space : limitHistorySpaceByHostDisk(space, hint);
};

// A first turn reserves its estimate until its checkouts stand, so concurrent turns cannot all spend the same room.
// Written bytes may also be in statfs by now; counting those twice is conservative until that checkout finishes.
const reservations = new Map<string, number>();
// The floor is said once per conversation, as a low-memory hold is (resource-budget.ts): the next try for it goes ahead,
// since the person told knows what else this disk is about to hold. Never past a checkout that cannot fit at all, which
// would only fail half-written. A reading with room again forgets the warning (2026-10-30: before this, a short disk
// refused every press, and Send again could only be refused again).
const warned = new Set<string>();
export const reserveCheckoutSpace = async (
    root: string,
    bytes: number,
    read: () => Promise<HistorySpace> = () => readHistorySpace(root),
    owner?: string,
): Promise<() => void> => {
    const space = await read();
    const pending = reservations.get(root) ?? 0;
    const key = owner === undefined ? undefined : `${root}\0${owner}`;
    if (checkoutSpace(space, bytes + pending).allowed) {
        if (key !== undefined) {
            warned.delete(key);
        }
    } else if (hostDriveCritical(space) || key === undefined || !warned.has(key) || space.freeBytes < bytes + pending) {
        if (key !== undefined) {
            warned.add(key);
        }
        throw new CheckoutSpaceRefused(space.freeBytes, bytes, space.limitedBy);
    }
    reservations.set(root, pending + bytes);
    return () => {
        const remaining = (reservations.get(root) ?? 0) - bytes;
        if (remaining === 0) {
            reservations.delete(root);
        } else {
            reservations.set(root, remaining);
        }
    };
};
