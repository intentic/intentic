import { describe, it, expect } from "bun:test";
import { foldUnchangedRows, MAX_ROWS, type RowDiff, type Sheet, sheetOfDelimited, sheetsOfMarkdown, tableDiff } from "./tableDiff";

const sheet = (name: string, ...rows: string[][]): Sheet => ({ name, rows });
const kinds = (rows: readonly RowDiff[]): string[] => rows.map((row) => row.kind);

describe(`parsing fileq's rendering of a workbook`, () => {
    it(`reads each sheet's table, header first, skipping the separator row and undoing the pipe escape`, () => {
        const sheets = sheetsOfMarkdown(`## Prices\n\n| Item | Cost |\n| --- | --- |\n| Bread | 2 |\n| A \\| B | 3 |\n\n## Notes\n\n(empty sheet)`);
        expect(sheets).toEqual([
            {
                name: `Prices`,
                rows: [
                    [`Item`, `Cost`],
                    [`Bread`, `2`],
                    [`A | B`, `3`],
                ],
            },
            { name: `Notes`, rows: [] },
        ]);
    });
});

describe(`parsing delimited text`, () => {
    it(`sniffs the delimiter and honours quotes, doubled quotes and quoted newlines`, () => {
        expect(sheetOfDelimited(`a;b\n"x;y";"say ""hi"""\n"two\nlines";z\n`, `data.csv`).rows).toEqual([
            [`a`, `b`],
            [`x;y`, `say "hi"`],
            [`two\nlines`, `z`],
        ]);
        expect(sheetOfDelimited(`a\tb\n1\t2`, `t.tsv`).rows).toEqual([
            [`a`, `b`],
            [`1`, `2`],
        ]);
    });

    it(`drops blank lines rather than reading them as empty rows`, () => {
        expect(sheetOfDelimited(`a,b\n\n1,2\n\n`, `x.csv`).rows).toHaveLength(2);
    });
});

describe(`tableDiff`, () => {
    it(`pairs an edited row with what it became and marks the one cell that moved`, () => {
        const [diff] = tableDiff(
            [sheet(`S`, [`Item`, `Cost`], [`Bread`, `2`], [`Milk`, `1`])],
            [sheet(`S`, [`Item`, `Cost`], [`Bread`, `3`], [`Milk`, `1`])],
        );
        expect(diff?.kind).toBe(`changed`);
        expect(kinds(diff!.rows)).toEqual([`same`, `changed`, `same`]);
        expect(diff!.rows[1]!.cells).toEqual([
            { kind: `same`, before: `Bread`, after: `Bread` },
            { kind: `changed`, before: `2`, after: `3` },
        ]);
        expect(diff!.rows[1]).toMatchObject({ beforeLine: 2, afterLine: 2 });
        expect(diff!.changedRows).toBe(1);
    });

    it(`reads an inserted row as added, with the rows below it still the same rows`, () => {
        const [diff] = tableDiff([sheet(`S`, [`h`], [`a`], [`c`])], [sheet(`S`, [`h`], [`a`], [`b`], [`c`])]);
        expect(kinds(diff!.rows)).toEqual([`same`, `same`, `added`, `same`]);
        expect(diff!.rows[2]).toMatchObject({ afterLine: 3 });
        expect(diff!.rows[3]).toMatchObject({ beforeLine: 3, afterLine: 4 });
    });

    it(`leaves two unrelated rows as a removal and an addition rather than forcing a pair`, () => {
        const [diff] = tableDiff([sheet(`S`, [`h`, `h2`, `h3`], [`a`, `b`, `c`])], [sheet(`S`, [`h`, `h2`, `h3`], [`x`, `y`, `z`])]);
        expect(kinds(diff!.rows)).toEqual([`same`, `removed`, `added`]);
    });

    it(`matches sheets by name: a renamed sheet is one removed and one added, a new one comes last`, () => {
        const diffs = tableDiff([sheet(`Old`, [`h`]), sheet(`Kept`, [`h`])], [sheet(`Kept`, [`h`]), sheet(`New`, [`h`], [`1`])]);
        expect(diffs.map((diff) => [diff.name, diff.kind])).toEqual([
            [`Old`, `removed`],
            [`Kept`, `same`],
            [`New`, `added`],
        ]);
        expect(diffs[2]?.changedRows).toBe(2);
    });

    it(`reports the widest row as the column count so a grown row still draws whole`, () => {
        const [diff] = tableDiff([sheet(`S`, [`a`, `b`])], [sheet(`S`, [`a`, `b`, `c`])]);
        expect(diff?.columns).toBe(3);
        expect(diff?.rows[0]?.cells.at(-1)).toEqual({ kind: `added`, after: `c` });
    });

    it(`diffs rows appended to a long sheet without building a table over the whole of it`, () => {
        const rows = Array.from({ length: MAX_ROWS - 10 }, (_, index) => [`row ${index}`, String(index)]);
        const [diff] = tableDiff([sheet(`S`, ...rows)], [sheet(`S`, ...rows, [`row new`, `x`])]);
        expect(diff?.changedRows).toBe(1);
        expect(diff?.rows.at(-1)).toMatchObject({ kind: `added`, afterLine: rows.length + 1 });
    });
});

describe(`foldUnchangedRows`, () => {
    it(`keeps the header and one row of context on each side of a change, folding the rest`, () => {
        const rows: RowDiff[] = Array.from({ length: 12 }, (_, index) => ({
            kind: index === 8 ? `changed` : `same`,
            cells: [],
            beforeLine: index + 1,
            afterLine: index + 1,
        }));
        const runs = foldUnchangedRows(rows);
        expect(runs.map((run) => (run.kind === `fold` ? `fold:${run.count}` : run.row.kind))).toEqual([
            `same`,
            `fold:6`,
            `same`,
            `changed`,
            `same`,
            `fold:2`,
        ]);
    });

    it(`shows an all-unchanged sheet whole`, () => {
        const rows: RowDiff[] = [
            { kind: `same`, cells: [] },
            { kind: `same`, cells: [] },
        ];
        expect(foldUnchangedRows(rows)).toHaveLength(2);
    });
});
