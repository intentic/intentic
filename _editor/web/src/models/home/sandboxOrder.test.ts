import { movedOrder } from "./sandboxOrder";

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
