import { diffRows, diffStat } from "./chatToolDiff";

describe(`diffRows`, () => {
    it(`renders a Write (no oldText) as all-add rows`, () => {
        expect(diffRows(undefined, `a\nb`)).toEqual([
            { type: `add`, text: `a` },
            { type: `add`, text: `b` },
        ]);
    });

    it(`keeps shared prefix/suffix as context around the changed middle`, () => {
        expect(diffRows(`keep\nold\ntail`, `keep\nnew\ntail`)).toEqual([
            { type: `context`, text: `keep` },
            { type: `del`, text: `old` },
            { type: `add`, text: `new` },
            { type: `context`, text: `tail` },
        ]);
    });

    it(`interleaves an insertion without deleting shared lines`, () => {
        expect(diffRows(`a\nc`, `a\nb\nc`)).toEqual([
            { type: `context`, text: `a` },
            { type: `add`, text: `b` },
            { type: `context`, text: `c` },
        ]);
    });

    it(`collapses long unchanged runs to their edges around a skip row`, () => {
        const shared = Array.from({ length: 20 }, (_, i) => `line${i}`).join(`\n`);
        const rows = diffRows(`start\n${shared}`, `changed\n${shared}`);
        expect(rows[0]).toEqual({ type: `del`, text: `start` });
        expect(rows[1]).toEqual({ type: `add`, text: `changed` });
        const skip = rows.find((row) => row.type === `skip`);
        expect(skip?.text).toContain(`unchanged`);
        // Edge context survives on the change side; the tail edge is dropped (nothing changed after it).
        expect(rows[2]).toEqual({ type: `context`, text: `line0` });
    });

    it(`caps pathological row counts`, () => {
        const rows = diffRows(undefined, Array.from({ length: 500 }, (_, i) => `l${i}`).join(`\n`));
        expect(rows.length).toBe(161);
        expect(rows.at(-1)?.type).toBe(`skip`);
    });
});

describe(`diffStat`, () => {
    it(`counts a replaced line as one add and one del`, () => {
        expect(diffStat(`keep\nold\ntail`, `keep\nnew\ntail`)).toEqual({ additions: 1, deletions: 1 });
    });

    it(`counts a whole-file Write as all additions, past the render cap`, () => {
        // The rendered rows cap at 160, but the stat is exact: every added line counts.
        expect(diffStat(undefined, Array.from({ length: 500 }, (_, i) => `l${i}`).join(`\n`))).toEqual({ additions: 500, deletions: 0 });
    });

    it(`counts a pure insertion with no deletions`, () => {
        expect(diffStat(`a\nc`, `a\nb\nc`)).toEqual({ additions: 1, deletions: 0 });
    });
});

// The card keeps its own 250,000-cell budget under the kit's 4,000,000: the trimmed middle below differs at both ends,
// so prefix/suffix trimming cannot shrink it, and `common` lines sit between the two changed edges.
describe(`the card's diff budget`, () => {
    const sides = (common: number): readonly [string, string] => {
        const shared = Array.from({ length: common }, (_, i) => `shared ${i}`);
        return [[`old head`, ...shared, `old tail`].join(`\n`), [`new head`, ...shared, `new tail`].join(`\n`)];
    };

    it(`finds the shared lines just under the budget (499 x 499 cells)`, () => {
        const [before, after] = sides(497);
        expect(diffStat(before, after)).toEqual({ additions: 2, deletions: 2 });
        const rows = diffRows(before, after);
        expect(rows.slice(0, 3)).toEqual([
            { type: `del`, text: `old head` },
            { type: `add`, text: `new head` },
            { type: `context`, text: `shared 0` },
        ]);
        expect(rows.at(-1)).toEqual({ type: `add`, text: `new tail` });
    });

    it(`replaces the whole middle just over it (501 x 501 cells), rather than paying for the table`, () => {
        const [before, after] = sides(499);
        expect(diffStat(before, after)).toEqual({ additions: 501, deletions: 501 });
        const rows = diffRows(before, after);
        expect(rows.slice(0, 2)).toEqual([
            { type: `del`, text: `old head` },
            { type: `del`, text: `shared 0` },
        ]);
        expect(rows.some((row) => row.type === `context`)).toBe(false);
    });
});
