import { describe, expect, it } from "vitest";
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
