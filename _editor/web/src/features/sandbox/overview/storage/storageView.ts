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

// A category's share of everything the scan counted, in percent. Measured against the counted total rather than the
// whole volume: against a terabyte disk every row's bar would be a sliver, and the bars are there to rank the rows.
export const shareOfCounted = (bytes: number, scan: StorageScan): number => {
    const whole = scan.categories.reduce((total, category) => total + category.bytes, 0);
    return whole <= 0 ? 0 : Math.min(100, (bytes / whole) * 100);
};

// What pressing every clean button would give back right now, as far as the daemon can say: a category that cannot
// name its figure (a package store) adds nothing rather than a guess.
export const freeableBytes = (scan: StorageScan): number =>
    scan.categories.reduce((total, category) => (category.cleanability === `none` ? total : total + (category.cleanableBytes ?? 0)), 0);

// How many of the largest categories the card lists before folding the rest behind one "more" row. The folded tail is
// the small change of the disk; the categories arrive largest first, so the split keeps the ones worth reading.
export const LEADING_CATEGORIES = 6;

export const splitCategories = <T>(categories: readonly T[], keep = LEADING_CATEGORIES): { readonly lead: readonly T[]; readonly rest: readonly T[] } =>
    // Folding a single row saves no space and costs a click, so a tail of one stays in the lead.
    categories.length <= keep + 1 ? { lead: categories, rest: [] } : { lead: categories.slice(0, keep), rest: categories.slice(keep) };

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
