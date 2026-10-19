import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { aspectFor, clampAspect, justifyRows, MAX_ASPECT, MIN_ASPECT, readsAsGallery, typicalAspect } from "./homeGallery";
import { moveInGrid } from "./homeGrid";
import { homeLayout } from "./homeLayout";
import type { HomeGroup } from "./homeOrder";

const METRICS = { width: 1000, targetHeight: 200, gap: 8 };

// What a row occupies across the pane, gaps included.
const rowWidth = (widths: readonly number[], gap = METRICS.gap): number => widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);

const file = (name: string): WorkspaceTreeEntry => ({ name, path: `shots/${name}`, type: `file` });
const dir = (name: string): WorkspaceTreeEntry => ({ name, path: `shots/${name}`, type: `dir` });

describe(`justified rows`, () => {
    it(`fill the pane's width exactly, every row but the last`, () => {
        const rows = justifyRows([1.5, 0.75, 1, 1.78, 1.33, 0.56, 1.5, 1.5, 1, 1.2, 0.8, 1.9], METRICS);
        expect(rows.length).toBeGreaterThan(1);
        for (const row of rows.slice(0, -1)) {
            expect(rowWidth(row.widths)).toBe(1000);
        }
    });

    it(`keep every row near the target height`, () => {
        const rows = justifyRows(
            Array.from({ length: 60 }, (_, at) => [1.5, 0.67, 1, 1.78, 2.2, 0.56][at % 6]!),
            METRICS,
        );
        for (const row of rows) {
            expect(row.height).toBeGreaterThan(200 * 0.65);
            expect(row.height).toBeLessThan(200 * 1.5);
        }
    });

    it(`keep each picture's shape: width over height is the picture's own`, () => {
        const aspects = [1.5, 0.75, 1, 1.78, 1.33, 0.56];
        const rows = justifyRows(aspects, METRICS);
        for (const row of rows) {
            // The last picture of a justified row takes the rounding, so it is the one allowed a few pixels.
            row.widths.slice(0, -1).forEach((width, at) => {
                expect(Math.abs(width / row.height - aspects[row.start + at]!)).toBeLessThan(0.02);
            });
        }
    });

    it(`leave the last row at the target height, left-aligned, rather than blowing two pictures up to fill it`, () => {
        const rows = justifyRows([1.5, 1.5, 1.5, 1.5, 1, 1], METRICS);
        const last = rows.at(-1)!;
        expect(last.height).toBe(200);
        expect(rowWidth(last.widths)).toBeLessThan(1000);
    });

    it(`number their pictures continuously, so a row knows which entries it holds`, () => {
        const rows = justifyRows(
            Array.from({ length: 23 }, () => 1.33),
            METRICS,
        );
        expect(rows[0]!.start).toBe(0);
        rows.slice(1).forEach((row, at) => expect(row.start).toBe(rows[at]!.start + rows[at]!.widths.length));
        expect(rows.at(-1)!.start + rows.at(-1)!.widths.length).toBe(23);
    });

    it(`give a picture wider than the pane a row of its own, no wider than the pane`, () => {
        const rows = justifyRows([2.5, 1], { ...METRICS, width: 300 });
        expect(rows[0]!.widths).toHaveLength(1);
        expect(rows[0]!.widths[0]).toBeLessThanOrEqual(300);
    });

    it(`hold a full-page screenshot and a panorama to shapes a row can carry`, () => {
        expect(clampAspect(1440 / 9000)).toBe(MIN_ASPECT);
        expect(clampAspect(8)).toBe(MAX_ASPECT);
        expect(clampAspect(Number.NaN)).toBe(1);
        expect(clampAspect(0)).toBe(1);
    });

    it(`lay out nothing for nothing`, () => {
        expect(justifyRows([], METRICS)).toEqual([]);
    });
});

describe(`which folders read as a gallery`, () => {
    it(`a folder of pictures, or of videos, does`, () => {
        expect(readsAsGallery([file(`a.png`), file(`b.jpg`), file(`c.webp`)])).toBe(true);
        expect(readsAsGallery([file(`9x16.mp4`), file(`16x9.mp4`)])).toBe(true);
    });

    it(`a project with a screenshot in it does not`, () => {
        expect(readsAsGallery([file(`README.md`), file(`index.ts`), file(`shot.png`)])).toBe(false);
        expect(readsAsGallery([file(`shot.png`)])).toBe(false);
    });

    it(`counts files, not the folders a gallery draws above it`, () => {
        expect(readsAsGallery([dir(`2024`), dir(`2025`), dir(`raw`), file(`a.png`), file(`b.png`)])).toBe(true);
    });

    it(`tolerates a stray file or two among the pictures`, () => {
        expect(readsAsGallery([file(`a.png`), file(`b.png`), file(`c.png`), file(`notes.md`)])).toBe(true);
        expect(readsAsGallery([file(`a.png`), file(`b.png`), file(`notes.md`), file(`list.csv`)])).toBe(false);
    });
});

describe(`proportions before a picture is measured`, () => {
    it(`guess the folder's typical shape, and the kind's own where nothing is known`, () => {
        expect(typicalAspect([])).toBeUndefined();
        expect(typicalAspect([1, 3, 2])).toBe(2);
        expect(aspectFor(file(`a.png`), 0.5, 1.5)).toBe(0.5);
        expect(aspectFor(file(`a.png`), undefined, 1.5)).toBe(1.5);
        expect(aspectFor(file(`a.mp4`), undefined, undefined)).toBeCloseTo(16 / 9);
        // A file a gallery has no picture of is a square card.
        expect(aspectFor(file(`notes.md`), undefined, 1.5)).toBe(1);
    });
});

describe(`a gallery inside the home's bands`, () => {
    const folders: HomeGroup = { key: `folders`, label: `Folders`, entries: [dir(`raw`), dir(`edits`)] };
    const pictures: HomeGroup = {
        key: `pictures`,
        label: `Pictures`,
        entries: Array.from({ length: 10 }, (_, at) => file(`${at}.png`)),
    };
    const aspects = [1.5, 1.5, 1.5, 0.75, 1, 1.78, 1.33, 0.56, 1.5, 1.5];
    const gallery = {
        ...METRICS,
        drawn: (group: HomeGroup) => group.key === `pictures`,
        aspectOf: (entry: WorkspaceTreeEntry) => aspects[Number.parseInt(entry.name, 10)]!,
        captionHeight: 24,
        rowGap: 12,
    };
    const layout = homeLayout([folders, pictures], true, { columns: 4, tileHeight: 100, labelHeight: 30 }, gallery);

    it(`keeps folders as tiles and lays pictures out as rows, each band its own height`, () => {
        expect(layout.bands.map((band) => band.kind)).toEqual([`label`, `tiles`, `label`, ...layout.bands.slice(3).map(() => `gallery` as const)]);
        layout.bands.forEach((band, at) => {
            if (band.kind === `gallery`) {
                expect(layout.heights[at]).toBe(band.height + 24 + 12);
            }
        });
        expect(layout.count).toBe(12);
    });

    it(`moves Down from a folder onto the picture standing under it, and back up`, () => {
        // The first folder stands over the first quarter of the pane; the first picture starts there too.
        expect(moveInGrid(layout, 0, `ArrowDown`)).toBe(2);
        expect(moveInGrid(layout, 2, `ArrowUp`)).toBe(0);
    });

    it(`lands on the picture standing under the one left, even where a narrower one's middle is nearer`, () => {
        // A square over the left half of a panorama, beside a small square: the panorama is under it.
        const wide = homeLayout(
            [
                {
                    key: `pictures`,
                    label: `Pictures`,
                    entries: [file(`0.png`), file(`1.png`), file(`2.png`), file(`3.png`), file(`4.png`)],
                },
            ],
            false,
            { columns: 4, tileHeight: 100, labelHeight: 30 },
            { ...gallery, width: 1000, targetHeight: 200, aspectOf: (entry) => [2, 2.5, 0.5, 2.5, 2.5][Number.parseInt(entry.name, 10)]! },
        );
        const [top, bottom] = wide.rows;
        const spanned = (row: typeof top, at: number) => row!.spans![at - row!.start]!;
        const from = top!.start + 1;
        const landed = moveInGrid(wide, from, `ArrowDown`);
        const [left, right] = spanned(top, from);
        const [under, over] = spanned(bottom, landed);
        expect(under).toBeLessThanOrEqual((left + right) / 2);
        expect(over).toBeGreaterThanOrEqual((left + right) / 2);
    });

    it(`moves between gallery rows by where the pictures stand, not by their place in the row`, () => {
        const [first, second] = layout.rows.slice(1);
        const lastOfFirst = first!.start + first!.count - 1;
        const landed = moveInGrid(layout, lastOfFirst, `ArrowDown`);
        // The rightmost picture of a row lands on the rightmost of the next, whatever their counts.
        expect(landed).toBe(second!.start + second!.count - 1);
    });
});
