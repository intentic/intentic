import { statfs } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { STORAGE_CLEANABILITY, type StorageCategoryId, type StorageCategoryUsage, type StorageScan } from "@intentic/sandbox-contract";
import { BROWSER_LOCK, type CleanCandidate, inFlight, planClean } from "./clean-plan.js";
import { namedByProgram, type RunningProgram } from "./running-programs.js";
import {
    classifyStoragePath,
    locateStoragePath,
    removalOf,
    type StorageClassification,
    type StorageRootKind,
    type StorageRoots,
} from "./storage-catalog.js";
import { abortError, type TreeVisitor, type WalkedFile, walkTree } from "./storage-walk.js";

// Sizes the sandbox's volumes by category in one bounded walk. Every file counts toward the item its path names, once
// however many links it has; a cleanable category also works out what a clean would free now, through the plan the
// cleaner itself runs.

// Parts listed per category; the rest are still in its total.
const ITEMS_SHOWN = 8;

interface ItemTally {
    bytes: number;
    freeable: number;
    newestMs: number;
    busy: boolean;
    folder: boolean;
}

interface CategoryTally {
    bytes: number;
    files: number;
    // A file clean's share, decided file by file as the walk meets them.
    cleanable: number;
    readonly items: Map<string, ItemTally>;
}

interface WalkContext {
    readonly root: StorageRootKind;
    readonly base: string;
    // Set once a folder's whole subtree reads the same, so the files below it skip the table.
    readonly settled?: StorageClassification;
}

export interface ScanOptions {
    readonly roots: StorageRoots;
    // The same volumes as their owner knows them (`/work` rather than the volume it links to), for the listed paths.
    readonly shown: StorageRoots;
    readonly now: () => number;
    readonly budgetMs: number;
    readonly signal: AbortSignal;
    readonly programs: () => Promise<readonly RunningProgram[]>;
}

const emptyItem = (): ItemTally => ({ bytes: 0, freeable: 0, newestMs: 0, busy: false, folder: false });

const topItems = (items: ReadonlyMap<string, ItemTally>): StorageCategoryUsage["items"] =>
    [...items]
        .map(([path, item]) => ({ path, bytes: item.bytes }))
        .toSorted((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
        .slice(0, ITEMS_SHOWN);

// What an entry clean would take of the items the walk tallied, by the same plan and the same running programs.
const entryCleanable = (category: StorageCategoryId, items: ReadonlyMap<string, ItemTally>, options: ScanOptions, running: readonly RunningProgram[]) => {
    const candidates: CleanCandidate[] = [...items].map(([path, item]) => ({
        path,
        folder: item.folder,
        bytes: item.bytes,
        freeable: item.freeable,
        newestMs: item.newestMs,
        busy: item.busy || namedByProgram(running, path),
    }));
    return planClean(category, candidates, options.roots, options.now()).targets.reduce((total, target) => total + target.freeable, 0);
};

// Where the owner knows a path to be (`/work`, not the volume it links to), through the root it was walked under.
const shownPath = (options: ScanOptions, path: string): string => {
    const located = locateStoragePath(options.roots, path);
    const base = located === undefined ? undefined : options.shown[located.root];
    return located === undefined || base === undefined ? path : join(base, located.rel);
};

const usageOf = (category: StorageCategoryId, tally: CategoryTally, options: ScanOptions, running: readonly RunningProgram[]): StorageCategoryUsage => {
    const unit = removalOf(category)?.unit;
    const cleanable = unit === "entry" ? entryCleanable(category, tally.items, options, running) : unit === "file" ? tally.cleanable : undefined;
    return {
        id: category,
        cleanability: STORAGE_CLEANABILITY[category],
        bytes: tally.bytes,
        files: tally.files,
        ...(cleanable === undefined ? {} : { cleanableBytes: cleanable }),
        items: topItems(tally.items).map((item) => ({ ...item, path: shownPath(options, item.path) })),
    };
};

export const scanStorage = async (options: ScanOptions): Promise<StorageScan> => {
    const { roots, signal } = options;
    const startedAt = options.now();
    const deadline = Date.now() + options.budgetMs;
    const tallies = new Map<StorageCategoryId, CategoryTally>();
    // Inodes already counted: a hard link is the same bytes under a second name.
    const seen = new Set<string>();
    const bases = new Set(Object.values(roots).filter((base): base is string => base !== undefined));

    const classify = (context: WalkContext, path: string): StorageClassification =>
        context.settled ?? classifyStoragePath(context.root, relative(context.base, path));
    const itemOf = (context: WalkContext, classified: StorageClassification): { category: CategoryTally; item: ItemTally; path: string } => {
        const category = tallies.get(classified.category) ?? { bytes: 0, files: 0, cleanable: 0, items: new Map<string, ItemTally>() };
        tallies.set(classified.category, category);
        const path = join(context.base, classified.item);
        const item = category.items.get(path) ?? emptyItem();
        category.items.set(path, item);
        return { category, item, path };
    };
    const count = (context: WalkContext, file: WalkedFile): void => {
        if (file.nlink > 1 && seen.has(file.inode)) {
            return;
        }
        if (file.nlink > 1) {
            seen.add(file.inode);
        }
        const classified = classify(context, file.path);
        const { category, item, path } = itemOf(context, classified);
        const freeable = file.nlink === 1 ? file.size : 0;
        category.bytes += file.size;
        category.files += 1;
        item.bytes += file.size;
        item.freeable += freeable;
        item.newestMs = Math.max(item.newestMs, file.mtimeMs);
        item.busy ||= inFlight(file.path);
        item.folder ||= path !== file.path;
        if (removalOf(classified.category)?.unit === "file") {
            const candidate = { path: file.path, folder: false, bytes: file.size, freeable, newestMs: file.mtimeMs, busy: inFlight(file.path) };
            category.cleanable += planClean(classified.category, [candidate], roots, startedAt).targets.length === 1 ? freeable : 0;
        }
    };
    const visitor: TreeVisitor<WalkContext> = {
        folder: (path, parent) => {
            // Another root nested inside this one is walked as itself, never twice.
            if (bases.has(path)) {
                return "skip";
            }
            if (parent.settled !== undefined) {
                return parent;
            }
            const classified = classifyStoragePath(parent.root, relative(parent.base, path));
            return classified.settled ? { ...parent, settled: classified } : parent;
        },
        file: (file, context) => count(context, file),
        link: (path, context) => {
            if (basename(path) === BROWSER_LOCK) {
                itemOf(context, classify(context, path)).item.busy = true;
            }
        },
    };

    let unreadable = 0;
    let complete = true;
    for (const [root, base] of Object.entries(roots) as [StorageRootKind, string | undefined][]) {
        if (base === undefined) {
            continue;
        }
        const outcome = await walkTree(base, { root, base }, visitor, { signal, deadline });
        unreadable += outcome.unreadable;
        complete &&= outcome.complete;
    }

    const running = await options.programs();
    // Cancelled while the process table was read: nothing below may land as the new result.
    if (signal.aborted) {
        throw abortError();
    }
    // A lock alone opens a tally; a category is listed only once it holds a file.
    const categories = [...tallies]
        .filter(([, tally]) => tally.files > 0)
        .map(([category, tally]) => usageOf(category, tally, options, running))
        .toSorted((left, right) => right.bytes - left.bytes);
    const volume = await statfs(roots.workspace).catch(() => undefined);
    return {
        startedAt,
        finishedAt: options.now(),
        outcome: complete ? "complete" : "partial",
        ...(volume === undefined ? {} : { disk: { usedBytes: (volume.blocks - volume.bfree) * volume.bsize, totalBytes: volume.blocks * volume.bsize } }),
        categories,
        unreadable,
    };
};
