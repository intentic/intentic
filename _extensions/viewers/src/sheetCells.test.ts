import { describe, expect, it } from "vitest";
import { toCell, toRows } from "./sheetCells";

/* The parser hands back JS values, and this is the step that decides what the reader sees. Worth pinning
 * because the library underneath was swapped: the old one produced an HTML table and did its own formatting,
 * so every one of these decisions is new and none of them is enforced by a type. */

describe(`toCell`, () => {
    it(`passes the three types the template renders through untouched`, () => {
        expect(toCell(`Widget`)).toBe(`Widget`);
        expect(toCell(12)).toBe(12);
        expect(toCell(0)).toBe(0);
        expect(toCell(true)).toBe(true);
        expect(toCell(false)).toBe(false);
    });

    it(`renders an empty cell as blank rather than as a word`, () => {
        // A sheet is mostly holes. `null` and `undefined` both have to reach the template as nothing at all:
        // rendering the string "null" down a column is the classic version of this bug.
        expect(toCell(null)).toBeNull();
        expect(toCell(undefined)).toBeNull();
    });

    it(`writes a date-only cell without a midnight stamp, and keeps a time when there is one`, () => {
        expect(toCell(new Date(Date.UTC(2026, 0, 15)))).toBe(`2026-01-15`);
        expect(toCell(new Date(Date.UTC(2026, 5, 2, 14, 30, 5)))).toBe(`2026-06-02 14:30:05`);
    });

    it(`falls back to a string rather than dropping a value it did not expect`, () => {
        // Losing one odd cell is a bad preview; throwing here would lose the whole sheet.
        expect(toCell({ toString: () => `odd` })).toBe(`odd`);
    });
});

describe(`toRows`, () => {
    it(`converts a ragged sheet cell by cell, preserving row lengths`, () => {
        const rows = toRows([[`Name`, `Qty`, `When`], [`Widget`, 3, new Date(Date.UTC(2026, 0, 15))], [`Gadget`, null], []]);
        expect(rows).toEqual([[`Name`, `Qty`, `When`], [`Widget`, 3, `2026-01-15`], [`Gadget`, null], []]);
    });
});
