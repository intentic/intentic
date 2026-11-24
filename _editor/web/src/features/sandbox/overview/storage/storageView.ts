import type { StorageCategoryUsage, StorageCleanResult, StorageScan } from "@intentic/sandbox-contract/schemas/metrics";
import type { NoticeModel } from "@intentic/ui";
import { formatBytes } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { storageCategoryLabel } from "./storageCategories";

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

// A category's share of everything the scan counted, in percent: what the sandbox's own space is made of, said on a
// tile of the map and on the category's page. Measured against the counted total rather than the whole volume, whose
// unclaimed rest is the map's own stretch of the bar.
export const shareOfCounted = (bytes: number, scan: StorageScan): number => {
    const whole = scan.categories.reduce((total, category) => total + category.bytes, 0);
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

// What the last clean did, said once and in words: what it gave back, and what it deliberately left. A run over several
// categories says them as one sum, since the reader ticked them as one decision.
export const cleanedNotice = (results: readonly StorageCleanResult[]): NoticeModel | undefined => {
    const [first] = results;
    if (first === undefined) {
        return undefined;
    }
    const freed = formatBytes(results.reduce((total, result) => total + result.freedBytes, 0));
    const kept = results.reduce((total, result) => total + result.kept, 0);
    const failed = results.reduce((total, result) => total + result.failed, 0);
    const details = [
        ...(kept === 0 ? [] : [t(`sandbox.sandboxStorageCard.keptItems`, { count: kept }, kept)]),
        ...(failed === 0 ? [] : [t(`sandbox.sandboxStorageCard.failedItems`, { count: failed }, failed)]),
    ];
    const title =
        results.length === 1
            ? t(`sandbox.sandboxStorageCard.freed`, { bytes: freed, category: storageCategoryLabel(first.category) })
            : t(`sandbox.sandboxStorageCard.freedMany`, { bytes: freed, count: results.length }, results.length);
    const tone = failed === 0 ? `info` : `warning`;
    return details.length === 0 ? { tone, title } : { tone, title, detail: details.join(` `) };
};
