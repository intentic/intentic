// Checkout admission uses available blocks: reserved filesystem space cannot hold a user's checkout.
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
    `The sandbox's disk has ${gigabytes(freeBytes)} free, too little to give this conversation its own copy of the workspace (about ${gigabytes(checkoutBytes)}). Free space in Settings → Storage, then send again.`;

export class CheckoutSpaceRefused extends Error {
    constructor(freeBytes: number, checkoutBytes: number) {
        super(checkoutRefusal(freeBytes, checkoutBytes));
        this.name = "CheckoutSpaceRefused";
    }
}
