// Pins which table diffs run on the render thread: only those whose worst case, every row changed, stays cheap.
import { MAX_ROWS, type Sheet, tableDiff } from "./tableDiff";
import { diffTables, INLINE_CELL_PAIRS, worstCaseCellPairs } from "./tableDiffClient";

const oneColumn = (rows: number): Sheet => ({ name: `S`, rows: Array.from({ length: rows }, (_, index) => [String(index)]) });
// Rows per side of a one-column pair that lands exactly on the budget.
const SIDE = Math.sqrt(INLINE_CELL_PAIRS);

describe(`diffTables`, () => {
    it(`counts rows times rows times the wider side, over the sheets both versions hold`, () => {
        const before: Sheet[] = [{ name: `S`, rows: [[`a`, `b`], [`c`]] }, { name: `Gone`, rows: [[`x`]] }];
        const after: Sheet[] = [{ name: `S`, rows: [[`a`], [`c`], [`d`, `e`, `f`]] }, { name: `New`, rows: [[`y`]] }];

        expect(worstCaseCellPairs({ before, after })).toBe(2 * 3 * 3);
    });

    it(`counts no more rows than the diff reads`, () => {
        expect(worstCaseCellPairs({ before: [oneColumn(MAX_ROWS + 10)], after: [oneColumn(1)] })).toBe(MAX_ROWS);
    });

    it(`answers a pair on the budget with the diff itself, drawn in the first frame`, () => {
        const before = [oneColumn(SIDE)];
        const after = [oneColumn(SIDE)];

        expect(worstCaseCellPairs({ before, after })).toBe(INLINE_CELL_PAIRS);
        expect(diffTables({ before, after })).toEqual(tableDiff(before, after));
    });

    it(`hands a pair one row over the budget to the worker`, () => {
        expect(diffTables({ before: [oneColumn(SIDE)], after: [oneColumn(SIDE + 1)] })).toBeInstanceOf(Promise);
    });
});
