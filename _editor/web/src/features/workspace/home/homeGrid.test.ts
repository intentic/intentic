import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { describe, expect, it } from "vitest";
import { isGridKey, moveInGrid } from "./homeGrid";
import { homeLayout, EMPTY_LAYOUT } from "./homeLayout";
import type { HomeGroup, HomeGroupKey } from "./homeOrder";

const entriesOf = (prefix: string, count: number): WorkspaceTreeEntry[] =>
    Array.from({ length: count }, (_, index) => ({ name: `${prefix}${index}`, path: `${prefix}${index}`, type: `file` as const }));

// Lays tiles out the way the home does: each group's entries wrap at `columns`, groups stacked in order.
const laidOut = (columns: number, ...groupSizes: number[]) => {
    const keys: HomeGroupKey[] = [`folders`, `documents`, `pictures`, `media`];
    const groups: HomeGroup[] = groupSizes.map((size, at) => ({ key: keys[at]!, label: keys[at]!, entries: entriesOf(`${at}-`, size) }));
    return homeLayout(groups, true, { columns, tileHeight: 100, labelHeight: 30 });
};

describe(`arrow travel over the home`, () => {
    // Four tiles in three columns: [0 1 2] / [3], then a second group of two: [4 5].
    const layout = laidOut(3, 4, 2);

    it(`walks home order sideways, across a group boundary too`, () => {
        expect(moveInGrid(layout, 0, `ArrowRight`)).toBe(1);
        expect(moveInGrid(layout, 3, `ArrowRight`)).toBe(4);
        expect(moveInGrid(layout, 4, `ArrowLeft`)).toBe(3);
    });

    it(`holds at either end rather than wrapping`, () => {
        expect(moveInGrid(layout, 0, `ArrowLeft`)).toBe(0);
        expect(moveInGrid(layout, 5, `ArrowRight`)).toBe(5);
    });

    it(`goes down to the tile under this one`, () => {
        expect(moveInGrid(layout, 0, `ArrowDown`)).toBe(3);
        expect(moveInGrid(layout, 3, `ArrowUp`)).toBe(0);
    });

    it(`lands on the nearest tile when the row below is shorter, and into the next group past it`, () => {
        // Nothing under column 2 in the first group's second row: the closest tile there is the row's only one.
        expect(moveInGrid(layout, 2, `ArrowDown`)).toBe(3);
        // Down from the partial row crosses into the next group.
        expect(moveInGrid(layout, 3, `ArrowDown`)).toBe(4);
        expect(moveInGrid(layout, 5, `ArrowUp`)).toBe(3);
    });

    it(`holds where there is no row in that direction`, () => {
        expect(moveInGrid(layout, 1, `ArrowUp`)).toBe(1);
        expect(moveInGrid(layout, 5, `ArrowDown`)).toBe(5);
    });

    it(`starts from nothing at the first tile, or the last for End`, () => {
        expect(moveInGrid(layout, -1, `ArrowDown`)).toBe(0);
        expect(moveInGrid(layout, -1, `ArrowLeft`)).toBe(0);
        expect(moveInGrid(layout, -1, `End`)).toBe(5);
        expect(moveInGrid(layout, 2, `Home`)).toBe(0);
    });

    it(`has nowhere to go on an empty home`, () => {
        expect(moveInGrid(EMPTY_LAYOUT, 0, `ArrowRight`)).toBe(-1);
    });

    it(`steps by the column count, not by a painted rectangle`, () => {
        // The same six tiles at two columns: [0 1] / [2 3] / [4 5] within one group.
        const narrow = laidOut(2, 6);
        expect(moveInGrid(narrow, 0, `ArrowDown`)).toBe(2);
        expect(moveInGrid(narrow, 5, `ArrowUp`)).toBe(3);
    });

    it(`names the keys it answers`, () => {
        expect(isGridKey(`ArrowUp`)).toBe(true);
        expect(isGridKey(`Enter`)).toBe(false);
    });
});
