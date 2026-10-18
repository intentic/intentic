import { statfs } from "node:fs/promises";
import { checkoutSpace, CheckoutSpaceRefused, type HistorySpace } from "./checkout-space.js";

export const readHistorySpace = async (root: string): Promise<HistorySpace> => {
    const volume = await statfs(root);
    return { freeBytes: volume.bavail * volume.bsize, totalBytes: volume.blocks * volume.bsize };
};

// A first turn reserves its estimate until its checkouts stand, so concurrent turns cannot all spend the same room.
// Written bytes may also be in statfs by now; counting those twice is conservative until that checkout finishes.
const reservations = new Map<string, number>();
export const reserveCheckoutSpace = async (
    root: string,
    bytes: number,
    read: () => Promise<HistorySpace> = () => readHistorySpace(root),
): Promise<() => void> => {
    const space = await read();
    const pending = reservations.get(root) ?? 0;
    if (!checkoutSpace(space, bytes + pending).allowed) {
        throw new CheckoutSpaceRefused(space.freeBytes, bytes);
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
