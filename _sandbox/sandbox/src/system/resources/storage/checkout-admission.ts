import type { StatsFs } from "node:fs";
import { statfs } from "node:fs/promises";
import { checkoutSpace, CheckoutSpaceRefused, type HistorySpace } from "./checkout-space.js";

// Root's writes may fill the reserved blocks an unprivileged writer is kept out of (checkout-space.ts).
export const readHistorySpace = async (
    root: string,
    privileged = process.geteuid?.() === 0,
    readVolume: (root: string) => Promise<StatsFs> = statfs,
): Promise<HistorySpace> => {
    const volume = await readVolume(root);
    return { freeBytes: (privileged ? volume.bfree : volume.bavail) * volume.bsize, totalBytes: volume.blocks * volume.bsize };
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
    } else if (key === undefined || !warned.has(key) || space.freeBytes < bytes + pending) {
        if (key !== undefined) {
            warned.add(key);
        }
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
