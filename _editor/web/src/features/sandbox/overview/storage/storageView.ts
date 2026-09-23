import type { StorageCategoryUsage, StorageScan } from "@intentic/sandbox-contract";

// How the Disk card reads a scan: what the scan could not account for, how full the volume is, and what each
// category's button offers. Pure, so the card draws decisions rather than making them.

// Space the volume reports used that no category holds: the system itself, other programs' data sharing the disk, and
// the filesystem's own overhead. Absent when the volume would not say, or when the categories cover it.
export const uncountedBytes = (scan: StorageScan): number | undefined => {
    if (scan.disk === undefined) {
        return undefined;
    }
    const rest = scan.disk.usedBytes - scan.categories.reduce((total, category) => total + category.bytes, 0);
    return rest > 0 ? rest : undefined;
};

// A category's share of the whole volume, in percent, so every row's bar is measured against the same length.
export const shareOfDisk = (bytes: number, scan: StorageScan): number => {
    const whole = scan.disk?.totalBytes ?? scan.categories.reduce((total, category) => total + category.bytes, 0);
    return whole <= 0 ? 0 : Math.min(100, (bytes / whole) * 100);
};

// What a category's button does. `waiting`: it may be cleaned, but nothing in it is old enough or idle enough yet.
// `clean` names the bytes it would free when the daemon could say, and whether it asks first.
export type CleanOffer =
    | { readonly kind: `none` }
    | { readonly kind: `waiting` }
    | { readonly kind: `clean`; readonly confirm: boolean; readonly bytes?: number };

export const cleanOffer = (category: StorageCategoryUsage): CleanOffer => {
    if (category.cleanability === `none`) {
        return { kind: `none` };
    }
    if (category.cleanableBytes === 0) {
        return { kind: `waiting` };
    }
    return {
        kind: `clean`,
        confirm: category.cleanability === `confirm`,
        ...(category.cleanableBytes === undefined ? {} : { bytes: category.cleanableBytes }),
    };
};
