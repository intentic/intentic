import { boardLayout, LOUD } from "../boardGrid";

// Pins how the board lays its lanes out: by its width, and by which lanes are empty, so an empty lane gives its column
// to the lanes with something to read.

const quiet = (...lanes: (keyof typeof LOUD)[]) => ({ ...LOUD, ...Object.fromEntries(lanes.map((lane) => [lane, true])) });

describe(`boardLayout`, () => {
    it(`stacks a narrow board whatever its lanes hold`, () => {
        expect(boardLayout(true, true, LOUD)).toEqual({ kind: `stacked` });
        expect(boardLayout(true, false, quiet(`attention`, `active`))).toEqual({ kind: `stacked` });
    });

    it(`lays a board with every lane full out by its width`, () => {
        expect(boardLayout(false, false, LOUD)).toEqual({ kind: `three` });
        expect(boardLayout(false, true, LOUD)).toEqual({ kind: `paired` });
    });

    it(`pairs Attention and Active in one column once either is empty, at any width`, () => {
        expect(boardLayout(false, false, quiet(`attention`))).toEqual({ kind: `paired` });
        expect(boardLayout(false, false, quiet(`active`))).toEqual({ kind: `paired` });
        expect(boardLayout(false, true, quiet(`attention`))).toEqual({ kind: `paired` });
    });

    it(`tucks an empty Finished under Active, giving Attention a column of its own`, () => {
        expect(boardLayout(false, false, quiet(`finished`))).toEqual({ kind: `tucked` });
        expect(boardLayout(false, true, quiet(`finished`))).toEqual({ kind: `tucked` });
    });

    it(`hands the board to the one lane holding anything`, () => {
        expect(boardLayout(false, false, quiet(`attention`, `active`))).toEqual({ kind: `ledger`, wide: `finished` });
        expect(boardLayout(false, false, quiet(`attention`, `finished`))).toEqual({ kind: `ledger`, wide: `active` });
        expect(boardLayout(false, true, quiet(`active`, `finished`))).toEqual({ kind: `ledger`, wide: `attention` });
    });

    it(`keeps the width's layout on a board with nothing in any lane`, () => {
        expect(boardLayout(false, false, quiet(`attention`, `active`, `finished`))).toEqual({ kind: `three` });
        expect(boardLayout(false, true, quiet(`attention`, `active`, `finished`))).toEqual({ kind: `paired` });
    });
});
