import { slotAt } from "./sandboxTileDrag";

describe(`slotAt`, () => {
    const middles = [20, 64, 108];

    it(`is the slot whose middle is nearest`, () => {
        expect([0, 41, 43, 100, 500].map((y) => slotAt(y, middles))).toEqual([0, 0, 1, 2, 2]);
    });
});
