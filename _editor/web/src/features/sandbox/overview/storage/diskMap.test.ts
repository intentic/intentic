import { STORAGE_CLEANABILITY, type StorageCategoryUsage, type StorageScan } from "@intentic/sandbox-contract/schemas/metrics";
import { cleanChoices, diskSegments, groupOf, mapTiles, sandboxShare, squarify } from "./diskMap";

// What the Disk card's map draws from a scan: which stretch of the bar each group takes, which categories get a tile
// of their own, how the tiles tile the box, and what the clean-up list offers. Pinned where a wrong figure would let
// the map claim more or less of the disk than the scan measured.

const usage = (over: Partial<StorageCategoryUsage> & Pick<StorageCategoryUsage, "id">): StorageCategoryUsage => ({
    cleanability: STORAGE_CLEANABILITY[over.id],
    bytes: 0,
    files: 0,
    items: [],
    ...over,
});

const scanOf = (categories: readonly StorageCategoryUsage[], disk?: StorageScan[`disk`]): StorageScan => {
    const scan: StorageScan = { startedAt: 1_790_000_000_000, finishedAt: 1_790_000_060_000, outcome: `complete`, categories: [...categories], unreadable: 0 };
    if (disk !== undefined) {
        scan.disk = disk;
    }
    return scan;
};

describe(`groupOf`, () => {
    it(`puts every category the daemon lets the card clean on the cleanable side, whatever it holds`, () => {
        expect(groupOf(usage({ id: `packageStores` }))).toBe(`free`);
        expect(groupOf(usage({ id: `trash` }))).toBe(`free`);
        expect(groupOf(usage({ id: `workspace` }))).toBe(`yours`);
        expect(groupOf(usage({ id: `checkouts` }))).toBe(`yours`);
        expect(groupOf(usage({ id: `engines` }))).toBe(`own`);
        expect(groupOf(usage({ id: `docker` }))).toBe(`own`);
    });
});

describe(`diskSegments`, () => {
    it(`lays each group, then what no category holds, end to end as fractions of the volume`, () => {
        const scan = scanOf([usage({ id: `logs`, bytes: 100 }), usage({ id: `workspace`, bytes: 200 }), usage({ id: `engines`, bytes: 100 })], {
            usedBytes: 600,
            totalBytes: 1000,
        });
        expect(diskSegments(scan)).toEqual([
            { key: `free`, bytes: 100, start: 0, size: 0.1 },
            { key: `yours`, bytes: 200, start: 0.1, size: 0.2 },
            { key: `own`, bytes: 100, start: 0.30000000000000004, size: 0.1 },
            { key: `outside`, bytes: 200, start: 0.4, size: 0.2 },
        ]);
    });

    it(`draws no stretch for an empty group, and no bar for a volume that would not say its size`, () => {
        const scan = scanOf([usage({ id: `workspace`, bytes: 500 })], { usedBytes: 500, totalBytes: 1000 });
        expect(diskSegments(scan)?.map((segment) => segment.key)).toEqual([`yours`]);
        expect(diskSegments(scanOf([usage({ id: `workspace`, bytes: 500 })]))).toBeUndefined();
    });

    // Categories can span volumes and count a linked file twice: the bar never runs past its own end.
    it(`clips a count larger than the volume to the bar`, () => {
        const segments = diskSegments(scanOf([usage({ id: `workspace`, bytes: 900 }), usage({ id: `engines`, bytes: 300 })], { usedBytes: 800, totalBytes: 1000 }));
        expect(segments?.map((segment) => [segment.key, segment.start, segment.size])).toEqual([
            [`yours`, 0, 0.9],
            [`own`, 0.9, 0.09999999999999998],
        ]);
        expect(sandboxShare(segments ?? [])).toBe(1);
    });

    it(`measures the sandbox's share without the space outside it`, () => {
        const segments = diskSegments(scanOf([usage({ id: `workspace`, bytes: 250 })], { usedBytes: 900, totalBytes: 1000 })) ?? [];
        expect(sandboxShare(segments)).toBe(0.25);
    });
});

describe(`mapTiles`, () => {
    it(`gives each category of a hundredth or more its own tile, largest first, and folds the rest into one`, () => {
        const tiles = mapTiles([
            usage({ id: `logs`, bytes: 4 }),
            usage({ id: `workspace`, bytes: 900 }),
            usage({ id: `engines`, bytes: 90 }),
            usage({ id: `state`, bytes: 5 }),
            usage({ id: `scratch`, bytes: 1 }),
            usage({ id: `docker`, bytes: 0 }),
        ]);
        expect(tiles).toEqual([
            { kind: `category`, id: `workspace`, group: `yours`, bytes: 900 },
            { kind: `category`, id: `engines`, group: `own`, bytes: 90 },
            { kind: `smaller`, ids: [`state`, `logs`, `scratch`], bytes: 10 },
        ]);
    });

    it(`keeps a lone small category on a tile of its own`, () => {
        const tiles = mapTiles([usage({ id: `workspace`, bytes: 995 }), usage({ id: `logs`, bytes: 5 })]);
        expect(tiles.map((tile) => tile.kind)).toEqual([`category`, `category`]);
    });
});

describe(`squarify`, () => {
    const area = (rect: { readonly w: number; readonly h: number }): number => rect.w * rect.h;

    it(`gives each item an area in proportion to its size, filling the box exactly`, () => {
        const items = [{ bytes: 6 }, { bytes: 6 }, { bytes: 4 }, { bytes: 3 }, { bytes: 2 }, { bytes: 2 }, { bytes: 1 }];
        const rects = squarify(items, 6, 4);
        expect(rects).toHaveLength(items.length);
        for (const rect of rects) {
            expect(area(rect)).toBeCloseTo(rect.bytes, 6);
            expect(rect.x).toBeGreaterThanOrEqual(-1e-9);
            expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
            expect(rect.x + rect.w).toBeLessThanOrEqual(6 + 1e-9);
            expect(rect.y + rect.h).toBeLessThanOrEqual(4 + 1e-9);
        }
        expect(rects.reduce((total, rect) => total + area(rect), 0)).toBeCloseTo(24, 6);
    });

    // The paper's own example: the first two sixes stand side by side down the short side rather than as slivers.
    it(`keeps tiles near square`, () => {
        const rects = squarify([{ bytes: 6 }, { bytes: 6 }, { bytes: 4 }, { bytes: 3 }, { bytes: 2 }, { bytes: 2 }, { bytes: 1 }], 6, 4);
        const worst = Math.max(...rects.map((rect) => Math.max(rect.w / rect.h, rect.h / rect.w)));
        expect(worst).toBeLessThan(3);
        expect(rects[0]).toMatchObject({ x: 0, y: 0, w: 3, h: 2 });
    });

    it(`lays nothing in a box with no room or for nothing at all`, () => {
        expect(squarify([{ bytes: 1 }], 0, 10)).toEqual([]);
        expect(squarify([{ bytes: 0 }], 10, 10)).toEqual([]);
        expect(squarify([], 10, 10)).toEqual([]);
    });
});

describe(`cleanChoices`, () => {
    it(`offers what may be cleaned now, the most it would give back first, and says which figures are only a ceiling`, () => {
        const choices = cleanChoices([
            usage({ id: `workspace`, bytes: 9000 }),
            usage({ id: `packageStores`, bytes: 3000 }),
            usage({ id: `trash`, bytes: 900, cleanableBytes: 800 }),
            usage({ id: `logs`, bytes: 400, cleanableBytes: 0 }),
            usage({ id: `buildCaches`, bytes: 5000, cleanableBytes: 50 }),
        ]);
        expect(choices).toEqual([
            { id: `packageStores`, bytes: 3000, exact: false, confirm: false },
            { id: `trash`, bytes: 800, exact: true, confirm: true },
            { id: `buildCaches`, bytes: 50, exact: true, confirm: false },
        ]);
    });
});
