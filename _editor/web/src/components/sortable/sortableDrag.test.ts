import { edgeScroll, movedOrder, slotAt } from "./sortableDrag";

describe(`movedOrder`, () => {
    it(`takes one out and puts it back where it was let go`, () => {
        expect(movedOrder([`a`, `b`, `c`, `d`], 0, 2)).toEqual([`b`, `c`, `a`, `d`]);
        expect(movedOrder([`a`, `b`, `c`, `d`], 3, 0)).toEqual([`d`, `a`, `b`, `c`]);
    });

    it(`keeps a move past either end at that end`, () => {
        expect(movedOrder([`a`, `b`, `c`], 1, 9)).toEqual([`a`, `c`, `b`]);
        expect(movedOrder([`a`, `b`, `c`], 1, -1)).toEqual([`b`, `a`, `c`]);
    });
});

describe(`slotAt`, () => {
    const middles = [20, 64, 108];

    it(`is the slot whose middle is nearest`, () => {
        expect([0, 41, 43, 100, 500].map((y) => slotAt(y, middles))).toEqual([0, 0, 1, 2, 2]);
    });
});

describe(`edgeScroll`, () => {
    it(`is still away from both edges`, () => {
        expect(edgeScroll(300, 0, 600)).toBe(0);
    });

    it(`scrolls toward the edge the pointer rests by, faster the deeper in`, () => {
        expect(edgeScroll(30, 0, 600)).toBeLessThan(0);
        expect(edgeScroll(0, 0, 600)).toBeLessThan(edgeScroll(30, 0, 600));
        expect(edgeScroll(590, 0, 600)).toBeGreaterThan(0);
        expect(edgeScroll(650, 0, 600)).toBe(edgeScroll(600, 0, 600));
    });
});
