import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "./csv.js";

describe("parseCsv", () => {
    it("reads plain rows", () => {
        expect(parseCsv("a,b\nc,d")).toEqual([
            ["a", "b"],
            ["c", "d"],
        ]);
    });

    it("keeps a comma, a newline and a doubled quote inside a quoted field", () => {
        expect(parseCsv('"a,b","line\nbreak","say ""hi"""')).toEqual([["a,b", "line\nbreak", 'say "hi"']]);
    });

    it("accepts CRLF, which is what a spreadsheet export actually writes", () => {
        expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([
            ["a", "b"],
            ["c", "d"],
        ]);
    });

    it("does not invent a trailing empty row", () => {
        expect(parseCsv("a\n")).toEqual([["a"]]);
        expect(parseCsv("")).toEqual([]);
    });

    it("keeps empty cells", () => {
        expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
    });
});

describe("toCsv", () => {
    it("quotes only what has to be quoted", () => {
        expect(toCsv([["plain", "with,comma", 'with"quote', "with\nnewline"]])).toBe('plain,"with,comma","with""quote","with\nnewline"');
    });

    it("writes an empty cell for a missing value rather than the word undefined", () => {
        expect(toCsv([["a", undefined, null]])).toBe("a,,");
    });

    it("round-trips anything it wrote", () => {
        const rows = [
            ["name", "note"],
            ["ana", 'said "yes", twice'],
            ["sam", "line\nbreak"],
        ];
        expect(parseCsv(toCsv(rows))).toEqual(rows);
    });
});
