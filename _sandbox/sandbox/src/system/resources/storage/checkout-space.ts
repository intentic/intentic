// Checkout admission counts the blocks the daemon's own writes can take: a root daemon may write the filesystem's reserved
// blocks too, so they count for it (2026-10-30: counting only `bavail` on a 1 TiB ext4 volume left its 5% reserve, about
// 50 GiB root could write, out, and refused a 0.6 GB checkout with 62 GB free).
export const GIB = 1024 ** 3;

export interface HistorySpace {
    readonly freeBytes: number;
    readonly totalBytes: number;
    readonly limitedBy?: { readonly drive: string; readonly driveFreeBytes: number } | undefined;
}

export const historySpaceFloor = (totalBytes: number): number => Math.min(20 * GIB, Math.max(5 * GIB, totalBytes * 0.02));

// A Windows drive that limits the reading is the person's whole computer, not the sandbox's disk alone: on 2026-11-21
// marta's reached 0 under a subagent fan-out, Windows dropped its restore points and the engine's disk stayed unreadable
// until WSL was restarted. Under 5% of what the engine can still hold there, nothing checks out, a second press included.
// Only a host-limited reading: a native disk keeps the 20 GiB-capped floor alone (2026-10-30, a 1 TiB volume with 62 GB
// free refusing a 0.6 GB checkout).
export const hostDriveCritical = (space: HistorySpace): boolean =>
    space.limitedBy !== undefined && space.totalBytes > 0 && space.freeBytes / space.totalBytes < 0.05;

export const checkoutSpace = (space: HistorySpace, checkoutBytes: number) => {
    const floorBytes = historySpaceFloor(space.totalBytes);
    return { floorBytes, allowed: !hostDriveCritical(space) && space.freeBytes >= floorBytes && space.freeBytes - checkoutBytes >= floorBytes };
};

const gigabytes = (bytes: number): string => `${Number((bytes / 1_000_000_000).toFixed(1))} GB`;

export const checkoutRefusal = (
    freeBytes: number,
    checkoutBytes: number,
    limitedBy?: HistorySpace["limitedBy"],
): string => {
    const limit = limitedBy === undefined ? "" : ` Windows drive ${limitedBy.drive} under the sandbox's engine has ${gigabytes(limitedBy.driveFreeBytes)} free.`;
    return `The sandbox's disk has ${gigabytes(freeBytes)} free, too little to give this conversation its own copy of the workspace (about ${gigabytes(checkoutBytes)}).${limit} Free space in Settings → Storage, or send again to check it out anyway.`;
};

export class CheckoutSpaceRefused extends Error {
    constructor(freeBytes: number, checkoutBytes: number, limitedBy?: HistorySpace["limitedBy"]) {
        super(checkoutRefusal(freeBytes, checkoutBytes, limitedBy));
        this.name = "CheckoutSpaceRefused";
    }
}
