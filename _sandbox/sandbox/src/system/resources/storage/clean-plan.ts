import type { StorageCategoryId } from "@intentic/sandbox-contract";
import {
    classifyStoragePath,
    isProtectedStoragePath,
    locateStoragePath,
    removalOf,
    type StorageClassification,
    type StorageRemoval,
    type StorageRoots,
} from "./storage-catalog.js";

// Which of a category's candidates a clean removes, and why each other one stays. Pure: the scan runs it to say what a
// clean would free, and the cleaner runs it again on candidates re-read from disk right before it removes anything.

// One thing a clean could remove, an entry below a category folder or a single file, as the disk last described it.
export interface CleanCandidate {
    readonly path: string;
    readonly folder: boolean;
    readonly bytes: number;
    // What removing it gives back: a file also linked from elsewhere frees nothing.
    readonly freeable: number;
    // The newest modification anywhere inside it, in milliseconds.
    readonly newestMs: number;
    // Held by something running (an open browser's lock, a file still being written, a program naming it), or partly
    // unreadable, which rules none of those out.
    readonly busy: boolean;
}

// The lock a running Chromium keeps in its profile folder: a link to nowhere, so it marks the folder rather than sizes it.
export const BROWSER_LOCK = "SingletonLock";

// A file still being written by the pack or download that renames it once done.
export const inFlight = (path: string): boolean => path.endsWith(".part");

// `elsewhere`: it no longer classifies as the category being cleaned, or has left the sandbox's volumes.
export type KeptReason = "elsewhere" | "protected" | "busy" | "recent";

export interface CleanPlan {
    readonly targets: readonly CleanCandidate[];
    readonly kept: readonly { readonly path: string; readonly reason: KeptReason }[];
}

// A file clean takes any file of its category; the other two remove exactly one item, never a folder of several.
const itemOf = (category: StorageCategoryId, removal: StorageRemoval | undefined, classified: StorageClassification): boolean =>
    classified.category === category && (removal?.unit === "file" || classified.unit);

// What the table says of the path itself, before anything about its contents: undefined when the category may take it.
const placement = (category: StorageCategoryId, candidate: CleanCandidate, roots: StorageRoots): "elsewhere" | "protected" | undefined => {
    const located = locateStoragePath(roots, candidate.path);
    const removal = removalOf(category);
    if (located === undefined || !itemOf(category, removal, classifyStoragePath(located.root, located.rel))) {
        return "elsewhere";
    }
    // No removal is a category no clean may touch; a folders-only one keeps the account files beside its folders.
    const accountState = removal?.foldersOnly === true && !candidate.folder;
    return removal === undefined || accountState || isProtectedStoragePath(located.root, located.rel) ? "protected" : undefined;
};

// Why one candidate stays, or undefined when it may go; asked in the order the answers are cheapest to trust.
const keptBecause = (category: StorageCategoryId, candidate: CleanCandidate, roots: StorageRoots, now: number): KeptReason | undefined => {
    const misplaced = placement(category, candidate, roots);
    if (misplaced !== undefined) {
        return misplaced;
    }
    if (candidate.busy) {
        return "busy";
    }
    // No window means nothing is too recent, a clock-skewed future modification included.
    const window = removalOf(category)?.keepRecentMs;
    return window !== undefined && now - candidate.newestMs < window ? "recent" : undefined;
};

export const planClean = (category: StorageCategoryId, candidates: readonly CleanCandidate[], roots: StorageRoots, now: number): CleanPlan => {
    const targets: CleanCandidate[] = [];
    const kept: { path: string; reason: KeptReason }[] = [];
    for (const candidate of candidates) {
        const reason = keptBecause(category, candidate, roots, now);
        if (reason === undefined) {
            targets.push(candidate);
        } else {
            kept.push({ path: candidate.path, reason });
        }
    }
    return { targets, kept };
};
