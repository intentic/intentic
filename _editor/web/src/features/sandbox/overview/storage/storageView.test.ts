import { STORAGE_CLEANABILITY, StorageCategoryIdSchema, type StorageCategoryUsage, type StorageScan } from "@intentic/sandbox-contract";
import { storageCategoryText } from "./storageCategories";
import { cleanOffer, freeableBytes, shareOfCounted, splitCategories, uncountedBytes } from "./storageView";

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

describe(`shareOfCounted`, () => {
    const counted = [usage({ id: `trash`, bytes: 100 }), usage({ id: `logs`, bytes: 300 })];

    it(`measures every row against what the scan counted, not the whole volume`, () => {
        expect(shareOfCounted(100, scanOf(counted, { usedBytes: 500, totalBytes: 100_000 }))).toBe(25);
    });

    it(`never draws past the end, and draws nothing from an empty scan`, () => {
        expect(shareOfCounted(2000, scanOf(counted))).toBe(100);
        expect(shareOfCounted(10, scanOf([]))).toBe(0);
    });
});

describe(`freeableBytes`, () => {
    it(`adds what each cleanable category would give back, and nothing for one that cannot say`, () => {
        const scan = scanOf([
            usage({ id: `workspace`, bytes: 900 }),
            usage({ id: `logs`, bytes: 300, cleanableBytes: 200 }),
            usage({ id: `modelWeights`, bytes: 100, cleanableBytes: 100 }),
            usage({ id: `packageStores`, bytes: 500 }),
        ]);
        expect(freeableBytes(scan)).toBe(300);
    });
});

describe(`splitCategories`, () => {
    const letters = [`a`, `b`, `c`, `d`, `e`, `f`, `g`, `h`, `i`];

    it(`lists the largest and folds the tail`, () => {
        expect(splitCategories(letters, 6)).toEqual({ lead: letters.slice(0, 6), rest: letters.slice(6) });
    });

    it(`never folds a tail of one row`, () => {
        expect(splitCategories(letters.slice(0, 7), 6)).toEqual({ lead: letters.slice(0, 7), rest: [] });
        expect(splitCategories([], 6)).toEqual({ lead: [], rest: [] });
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
