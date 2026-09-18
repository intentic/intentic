import { describe, expect, test } from "vitest";
import { notesOf } from "./docx.js";

// mammoth's messages as they reach the notes: a template's worth of style warnings folds to one line, everything
// else keeps its own, and the fold counts style names so two saves of one template agree.
const message = (text: string): { message: string } => ({ message: text });

describe("notesOf", () => {
    test("style warnings fold to one line counting distinct style names, whatever their ids", () => {
        const notes = notesOf([
            message("Unrecognised run style: 'Tekst treści (4) Exact' (Style ID: Teksttreci4Exact)"),
            message("Unrecognised run style: 'Tekst treści (4) Exact' (Style ID: 1009)"),
            message("Unrecognised paragraph style: 'Body Text 2' (Style ID: Tekstpodstawowy2)"),
            message("Unrecognised paragraph style: 'Body Text 2' (Style ID: Tekstpodstawowy2)"),
            message("Unrecognised table style: 'Grid' (Style ID: Grid)"),
        ]);
        expect(notes).toEqual(["docx conversion: 3 Word styles without a markdown equivalent, read as plain text"]);
    });

    test("one style reads in the singular", () => {
        expect(notesOf([message("Unrecognised paragraph style: 'Note' (Style ID: Note)")])).toEqual([
            "docx conversion: 1 Word style without a markdown equivalent, read as plain text",
        ]);
    });

    test("content the markdown lacks keeps a line each, capped, and comes before the style line", () => {
        const dropped = Array.from({ length: 7 }, (_, index) => message(`An unrecognised element was ignored: w:custom${index}`));
        const notes = notesOf([...dropped, message("Unrecognised run style: 'Emphasis' (Style ID: Emphasis)")]);
        expect(notes).toEqual([
            ...dropped.slice(0, 5).map((warning) => `docx conversion: ${warning.message}`),
            "docx conversion: 2 more warnings of the same kind",
            "docx conversion: 1 Word style without a markdown equivalent, read as plain text",
        ]);
    });

    test("no messages, no notes", () => {
        expect(notesOf([])).toEqual([]);
    });
});
