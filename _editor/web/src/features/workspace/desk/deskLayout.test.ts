import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { describe, expect, it } from "vitest";
import { bandOfIndex, deskLayout, rowIndexOf } from "./deskLayout";
import type { DeskGroup } from "./deskOrder";

const entriesOf = (prefix: string, count: number): WorkspaceTreeEntry[] =>
    Array.from({ length: count }, (_, index) => ({ name: `${prefix}${index}`, path: `${prefix}${index}`, type: `file` as const }));

const groupsOf = (...sizes: number[]): DeskGroup[] =>
    sizes.map((size, at) => ({ key: at === 0 ? `folders` : `documents`, label: `g${at}`, entries: entriesOf(`${at}-`, size) }));

const METRICS = { columns: 3, tileHeight: 100, labelHeight: 30 };

describe(`deskLayout`, () => {
    it(`wraps each group's entries at the column count`, () => {
        const layout = deskLayout(groupsOf(4), false, METRICS);
        expect(layout.bands.map((band) => band.kind)).toEqual([`tiles`, `tiles`]);
        expect(layout.rows.map((row) => row.count)).toEqual([3, 1]);
        expect(layout.count).toBe(4);
    });

    it(`gives each group a label band when labels are shown`, () => {
        const layout = deskLayout(groupsOf(4, 2), true, METRICS);
        expect(layout.bands.map((band) => band.kind)).toEqual([`label`, `tiles`, `tiles`, `label`, `tiles`]);
        expect(layout.heights).toEqual([30, 100, 100, 30, 100]);
    });

    it(`leaves labels out when a folder holds one kind`, () => {
        const layout = deskLayout(groupsOf(4, 2), false, METRICS);
        expect(layout.bands.every((band) => band.kind === `tiles`)).toBe(true);
        expect(layout.heights).toEqual([100, 100, 100]);
    });

    it(`numbers rows continuously across groups, so desk order and the keyboard axis agree`, () => {
        const layout = deskLayout(groupsOf(4, 2), true, METRICS);
        expect(layout.rows.map((row) => row.start)).toEqual([0, 3, 4]);
        expect(layout.count).toBe(6);
    });

    it(`grows the band count, not the tile count, as the pane narrows`, () => {
        const wide = deskLayout(groupsOf(600), false, { ...METRICS, columns: 6 });
        const narrow = deskLayout(groupsOf(600), false, { ...METRICS, columns: 2 });
        expect(wide.bands).toHaveLength(100);
        expect(narrow.bands).toHaveLength(300);
        expect(wide.count).toBe(narrow.count);
    });

    it(`lays a directory of fifty thousand out without measuring anything`, () => {
        const layout = deskLayout(groupsOf(50_000), false, { ...METRICS, columns: 8 });
        expect(layout.count).toBe(50_000);
        expect(layout.rows).toHaveLength(6250);
        // The scroll surface the spacer has to declare.
        expect(layout.heights.reduce((sum, height) => sum + height, 0)).toBe(625_000);
    });

    it(`lays out at one column however narrow, rather than dividing by zero`, () => {
        const layout = deskLayout(groupsOf(3), false, { ...METRICS, columns: 0 });
        expect(layout.columns).toBe(1);
        expect(layout.rows).toHaveLength(3);
    });
});

describe(`finding a tile`, () => {
    const layout = deskLayout(groupsOf(4, 2), true, METRICS);

    it(`finds the row a desk-order index sits in`, () => {
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
