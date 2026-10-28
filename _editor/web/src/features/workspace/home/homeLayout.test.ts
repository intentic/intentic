import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { moveInGrid } from "./homeGrid";
import { bandOfIndex, homeLayout, rowIndexOf } from "./homeLayout";
import type { HomeGroup } from "./homeOrder";

// Pictures by default: with no gallery they are the home's own tiles, which most of these tests travel.
const entriesOf = (prefix: string, count: number, extension = `.png`, type: `file` | `dir` = `file`): WorkspaceTreeEntry[] =>
    Array.from({ length: count }, (_, index) => ({ name: `${prefix}${index}${extension}`, path: `${prefix}${index}${extension}`, type }));

const groupsOf = (...sizes: number[]): HomeGroup[] =>
    sizes.map((size, at) => ({ key: at === 0 ? `pictures` : `media`, label: `g${at}`, entries: entriesOf(`${at}-`, size) }));

const METRICS = { columns: 3, tileHeight: 100, labelHeight: 30, chipColumns: 2, chipHeight: 40, cardColumns: 2, cardHeight: 160 };

describe(`homeLayout`, () => {
    it(`wraps each group's entries at the column count`, () => {
        const layout = homeLayout(groupsOf(4), false, METRICS);
        expect(layout.bands.map((band) => band.kind)).toEqual([`tiles`, `tiles`]);
        expect(layout.rows.map((row) => row.count)).toEqual([3, 1]);
        expect(layout.count).toBe(4);
    });

    it(`gives each group a label band when labels are shown`, () => {
        const layout = homeLayout(groupsOf(4, 2), true, METRICS);
        expect(layout.bands.map((band) => band.kind)).toEqual([`label`, `tiles`, `tiles`, `label`, `tiles`]);
        expect(layout.heights).toEqual([30, 100, 100, 30, 100]);
    });

    it(`leaves labels out when a folder holds one kind`, () => {
        const layout = homeLayout(groupsOf(4, 2), false, METRICS);
        expect(layout.bands.every((band) => band.kind === `tiles`)).toBe(true);
        expect(layout.heights).toEqual([100, 100, 100]);
    });

    it(`numbers rows continuously across groups, so home order and the keyboard axis agree`, () => {
        const layout = homeLayout(groupsOf(4, 2), true, METRICS);
        expect(layout.rows.map((row) => row.start)).toEqual([0, 3, 4]);
        expect(layout.count).toBe(6);
    });

    it(`grows the band count, not the tile count, as the pane narrows`, () => {
        const wide = homeLayout(groupsOf(600), false, { ...METRICS, columns: 6 });
        const narrow = homeLayout(groupsOf(600), false, { ...METRICS, columns: 2 });
        expect(wide.bands).toHaveLength(100);
        expect(narrow.bands).toHaveLength(300);
        expect(wide.count).toBe(narrow.count);
    });

    it(`lays a directory of fifty thousand out without measuring anything`, () => {
        const layout = homeLayout(groupsOf(50_000), false, { ...METRICS, columns: 8 });
        expect(layout.count).toBe(50_000);
        expect(layout.rows).toHaveLength(6250);
        // The scroll surface the spacer has to declare.
        expect(layout.heights.reduce((sum, height) => sum + height, 0)).toBe(625_000);
    });

    it(`lays out at one column however narrow, rather than dividing by zero`, () => {
        const layout = homeLayout(groupsOf(3), false, { ...METRICS, columns: 0 });
        expect(layout.columns).toBe(1);
        expect(layout.rows).toHaveLength(3);
    });
});

describe(`folders`, () => {
    const folders = { key: `folders` as const, label: `Folders`, entries: entriesOf(`dir-`, 3, ``, `dir`) };
    const layout = homeLayout([folders, ...groupsOf(3)], true, METRICS);

    it(`stand as rows of chips at the chips' own columns and height, over the files' tiles`, () => {
        expect(layout.bands.map((band) => band.kind)).toEqual([`label`, `chips`, `chips`, `label`, `tiles`]);
        expect(layout.heights).toEqual([30, 40, 40, 30, 100]);
        expect(layout.rows.map((row) => row.count)).toEqual([2, 1, 3]);
    });

    it(`hand Up and Down between the chips' columns and the tiles' by where each stands`, () => {
        // The lone chip of the second row spans the left half; the tile under its middle is the first.
        expect(moveInGrid(layout, 2, `ArrowDown`)).toBe(3);
        // The third tile stands under the right half, where the second row has no chip: the nearest is the lone one.
        expect(moveInGrid(layout, 5, `ArrowUp`)).toBe(2);
        expect(moveInGrid(layout, 1, `ArrowDown`)).toBe(2);
    });
});

describe(`files, by what each can show`, () => {
    it(`draws a file read from its start as a card and one with nothing inside to show as a chip`, () => {
        const layout = homeLayout(
            [
                { key: `documents`, label: `Documents`, entries: entriesOf(`doc-`, 3, `.md`) },
                { key: `config`, label: `Config`, entries: entriesOf(`conf-`, 2, `.json`) },
            ],
            true,
            METRICS,
        );
        expect(layout.bands.map((band) => band.kind)).toEqual([`label`, `cards`, `cards`, `label`, `chips`]);
        expect(layout.heights).toEqual([30, 160, 160, 30, 40]);
    });

    it(`lays a heading of mixed files out as runs, numbering them on through the heading`, () => {
        const today = { key: `today` as const, label: `Today`, entries: [...entriesOf(`n-`, 1, `.md`), ...entriesOf(`p-`, 2), ...entriesOf(`z-`, 1, `.zip`)] };
        const layout = homeLayout([today], true, METRICS);
        expect(layout.bands.map((band) => band.kind)).toEqual([`label`, `cards`, `tiles`, `chips`]);
        expect(layout.rows.map((row) => [row.start, row.count])).toEqual([
            [0, 1],
            [1, 2],
            [3, 1],
        ]);
        expect(new Set(layout.bands.map((band) => band.key)).size).toBe(layout.bands.length);
    });
});

describe(`finding a tile`, () => {
    const layout = homeLayout(groupsOf(4, 2), true, METRICS);

    it(`finds the row a home-order index sits in`, () => {
        expect(rowIndexOf(layout, 0)).toBe(0);
        expect(rowIndexOf(layout, 2)).toBe(0);
        expect(rowIndexOf(layout, 3)).toBe(1);
        expect(rowIndexOf(layout, 5)).toBe(2);
    });

    it(`reports an index outside the layout rather than guessing at one`, () => {
        expect(rowIndexOf(layout, -1)).toBe(-1);
        expect(rowIndexOf(layout, 6)).toBe(-1);
    });

    it(`names the band to scroll to, skipping the label bands between`, () => {
        expect(bandOfIndex(layout, 0)).toBe(1);
        expect(bandOfIndex(layout, 3)).toBe(2);
        expect(bandOfIndex(layout, 5)).toBe(4);
    });
});
