import { describe, expect, it } from "vitest";
import { isGridKey, moveInGrid, type TileBox } from "./deskGrid";

// Lays tiles out the way the desk does: each group is its own auto-fill grid of `columns`, groups stacked with a label's
// worth of space between them. Returns the boxes in document order.
const layout = (columns: number, ...groupSizes: number[]): TileBox[] => {
    const boxes: TileBox[] = [];
    let top = 0;
    for (const size of groupSizes) {
        for (let index = 0; index < size; index += 1) {
            boxes.push({ left: (index % columns) * 100, top: top + Math.floor(index / columns) * 100, width: 100, height: 100 });
        }
        top += Math.ceil(size / columns) * 100 + 30;
    }
    return boxes;
};

describe(`arrow travel over the desk`, () => {
    // Four tiles in three columns: [0 1 2] / [3], then a second group of two: [4 5].
    const boxes = layout(3, 4, 2);

    it(`walks document order sideways, across a group boundary too`, () => {
        expect(moveInGrid(boxes, 0, `ArrowRight`)).toBe(1);
        expect(moveInGrid(boxes, 3, `ArrowRight`)).toBe(4);
        expect(moveInGrid(boxes, 4, `ArrowLeft`)).toBe(3);
    });

    it(`holds at either end rather than wrapping`, () => {
        expect(moveInGrid(boxes, 0, `ArrowLeft`)).toBe(0);
        expect(moveInGrid(boxes, 5, `ArrowRight`)).toBe(5);
    });

    it(`goes down to the tile under this one`, () => {
        expect(moveInGrid(boxes, 0, `ArrowDown`)).toBe(3);
        expect(moveInGrid(boxes, 3, `ArrowUp`)).toBe(0);
    });

    it(`lands on the nearest tile when the row below is shorter, and into the next group past it`, () => {
        // Nothing under column 3 in the first group's second row: the closest tile there is the row's only one.
        expect(moveInGrid(boxes, 2, `ArrowDown`)).toBe(3);
        // Down from the partial row crosses into the next group.
        expect(moveInGrid(boxes, 3, `ArrowDown`)).toBe(4);
        expect(moveInGrid(boxes, 5, `ArrowUp`)).toBe(3);
    });

    it(`holds where there is no row in that direction`, () => {
        expect(moveInGrid(boxes, 1, `ArrowUp`)).toBe(1);
        expect(moveInGrid(boxes, 5, `ArrowDown`)).toBe(5);
    });

    it(`starts from nothing at the first tile, or the last for End`, () => {
        expect(moveInGrid(boxes, -1, `ArrowDown`)).toBe(0);
        expect(moveInGrid(boxes, -1, `ArrowLeft`)).toBe(0);
        expect(moveInGrid(boxes, -1, `End`)).toBe(5);
        expect(moveInGrid(boxes, 2, `Home`)).toBe(0);
    });

    it(`has nowhere to go on an empty desk`, () => {
        expect(moveInGrid([], 0, `ArrowRight`)).toBe(-1);
    });

    it(`names the keys it answers`, () => {
        expect(isGridKey(`ArrowUp`)).toBe(true);
        expect(isGridKey(`Enter`)).toBe(false);
    });
});
