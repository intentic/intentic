import { STORAGE_CLEANABILITY, StorageCategoryIdSchema, type StorageCategoryUsage, type StorageScan } from "@intentic/sandbox-contract";
import { storageCategoryText } from "./storageCategories";
import { cleanOffer, shareOfDisk, uncountedBytes } from "./storageView";

// What the Disk card decides from a scan: what the scan could not account for, how long each row's bar is, and what
// each category's button offers. Pinned at the edges, where a card would otherwise say something false.

const usage = (over: Partial<StorageCategoryUsage> & Pick<StorageCategoryUsage, "id">): StorageCategoryUsage => ({
    cleanability: STORAGE_CLEANABILITY[over.id],
    bytes: 0,
    files: 0,
    items: [],
    ...over,
});

const scanOf = (categories: readonly StorageCategoryUsage[], disk?: StorageScan[`disk`]): StorageScan => ({
    startedAt: 1_790_000_000_000,
    finishedAt: 1_790_000_060_000,
    outcome: `complete`,
    ...(disk === undefined ? {} : { disk }),
    categories: [...categories],
    unreadable: 0,
});

describe(`uncountedBytes`, () => {
    const counted = [usage({ id: `workspace`, bytes: 600 }), usage({ id: `logs`, bytes: 400 })];

    it(`names only what the volume holds beyond every category`, () => {
        expect(uncountedBytes(scanOf(counted, { usedBytes: 1001, totalBytes: 4000 }))).toBe(1);
        // Fully accounted for: nothing left to name, not a row reading zero.
        expect(uncountedBytes(scanOf(counted, { usedBytes: 1000, totalBytes: 4000 }))).toBeUndefined();
    });

    it(`says nothing when the volume would not say how full it is`, () => {
        expect(uncountedBytes(scanOf(counted))).toBeUndefined();
    });
});

describe(`shareOfDisk`, () => {
    it(`measures every row against the whole volume`, () => {
        expect(shareOfDisk(250, scanOf([], { usedBytes: 500, totalBytes: 1000 }))).toBe(25);
    });

    it(`falls back to what the scan counted, and never draws past the end`, () => {
        expect(shareOfDisk(100, scanOf([usage({ id: `trash`, bytes: 100 }), usage({ id: `logs`, bytes: 300 })]))).toBe(25);
        expect(shareOfDisk(2000, scanOf([], { usedBytes: 500, totalBytes: 1000 }))).toBe(100);
        expect(shareOfDisk(10, scanOf([]))).toBe(0);
    });
});

describe(`cleanOffer`, () => {
    it(`offers nothing where nothing may be cleaned`, () => {
        expect(cleanOffer(usage({ id: `checkouts`, bytes: 9000 }))).toEqual({ kind: `none` });
    });

    it(`waits when a cleanable category holds nothing old enough yet`, () => {
        expect(cleanOffer(usage({ id: `logs`, bytes: 900, cleanableBytes: 0 }))).toEqual({ kind: `waiting` });
    });

    it(`asks first exactly where the daemon says to, and names the bytes when it can`, () => {
        expect(cleanOffer(usage({ id: `trash`, bytes: 900, cleanableBytes: 900 }))).toEqual({ kind: `clean`, confirm: true, bytes: 900 });
        expect(cleanOffer(usage({ id: `logs`, bytes: 900, cleanableBytes: 1 }))).toEqual({ kind: `clean`, confirm: false, bytes: 1 });
        // A package store's own tool decides what goes, so there is no figure to promise.
        expect(cleanOffer(usage({ id: `packageStores`, bytes: 900 }))).toEqual({ kind: `clean`, confirm: false });
    });
});

describe(`storageCategoryText`, () => {
    // Discovered from the contract: a category added there without words would otherwise draw its own dotted key.
    it(`words every category, and warns before cleaning each one that asks first`, () => {
        const unworded = StorageCategoryIdSchema.options.flatMap((id) =>
            Object.entries(storageCategoryText({ id, cleanability: STORAGE_CLEANABILITY[id] }))
                .filter(([, words]) => words.startsWith(`sandbox.storageCategories.`))
                .map(([field]) => `${id}.${field}`),
        );
        expect(unworded).toEqual([]);
    });
});
