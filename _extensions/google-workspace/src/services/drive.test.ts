import { describe, expect, it } from "vitest";
import { driveQuery, exportMimeFor } from "./drive.js";

const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";

describe("driveQuery", () => {
    /* Nobody types `fullText contains 'budget' and trashed = false`, and a tool that demanded it would go
     * unused. A phrase is searched; a real query is respected. */
    it("turns a phrase into a full-text search that skips the bin", () => {
        expect(driveQuery("quarterly budget")).toBe("fullText contains 'quarterly budget' and trashed = false");
    });

    it("passes a real Drive query through untouched", () => {
        expect(driveQuery("name contains 'notes' and trashed = false")).toBe("name contains 'notes' and trashed = false");
        expect(driveQuery("'abc123' in parents")).toBe("'abc123' in parents");
        expect(driveQuery("mimeType = 'application/pdf'")).toBe("mimeType = 'application/pdf'");
    });

    // An apostrophe in a phrase would otherwise close the quoted literal and make the query a syntax error.
    it("escapes a quote in a phrase", () => {
        expect(driveQuery("ana's notes")).toBe("fullText contains 'ana\\'s notes' and trashed = false");
    });
});

describe("exportMimeFor", () => {
    it("defaults each Google format to the one worth reading", () => {
        expect(exportMimeFor(DOC, undefined)).toBe("text/markdown");
        expect(exportMimeFor(SHEET, undefined)).toBe("text/csv");
    });

    it("honours an asked-for format", () => {
        expect(exportMimeFor(DOC, "pdf")).toBe("application/pdf");
        expect(exportMimeFor(SHEET, "xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });

    // A Doc has no csv and a Sheet has no docx; Google answers a wrong pair with a 400 nobody can act on.
    it("refuses a format that kind of file does not have, and says which it does", () => {
        expect(() => exportMimeFor(DOC, "csv")).toThrow(/available: md, txt, pdf, docx, html/);
        expect(() => exportMimeFor(SHEET, "docx")).toThrow(/available: csv, xlsx, pdf/);
    });

    it("says so for a Google type nothing can export", () => {
        expect(() => exportMimeFor("application/vnd.google-apps.form", undefined)).toThrow(/cannot export/);
    });
});
