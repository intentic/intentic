// Checkout admission counts the blocks the daemon's own writes can take: a root daemon may write the filesystem's reserved
// blocks too, so they count for it (2026-10-30: counting only `bavail` on a 1 TiB ext4 volume left its 5% reserve, about
// 50 GiB root could write, out, and refused a 0.6 GB checkout with 62 GB free).
export const GIB = 1024 ** 3;

export interface HistorySpace {
    readonly freeBytes: number;
    readonly totalBytes: number;
}

export const historySpaceFloor = (totalBytes: number): number => Math.min(20 * GIB, Math.max(5 * GIB, totalBytes * 0.02));

export const checkoutSpace = (space: HistorySpace, checkoutBytes: number) => {
    const floorBytes = historySpaceFloor(space.totalBytes);
    return { floorBytes, allowed: space.freeBytes >= floorBytes && space.freeBytes - checkoutBytes >= floorBytes };
};

const gigabytes = (bytes: number): string => `${Number((bytes / 1_000_000_000).toFixed(1))} GB`;

export const checkoutRefusal = (freeBytes: number, checkoutBytes: number): string =>
    `The sandbox's disk has ${gigabytes(freeBytes)} free, too little to give this conversation its own copy of the workspace (about ${gigabytes(checkoutBytes)}). Free space in Settings → Storage, or send again to check it out anyway.`;

export class CheckoutSpaceRefused extends Error {
    constructor(freeBytes: number, checkoutBytes: number) {
        super(checkoutRefusal(freeBytes, checkoutBytes));
        this.name = "CheckoutSpaceRefused";
    }
}
