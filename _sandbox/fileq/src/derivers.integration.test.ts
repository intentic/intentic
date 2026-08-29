/* Every deriver against a real file its real parser accepts, in a temp tree. What each test pins is the
 * CONTRACT of the derivation — the text is there, the caps and degradations announce themselves — never the
 * parser's formatting details, which belong to the libraries. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { docxDeriver } from "./lib/derivers/docx.js";
import { htmlDeriver } from "./lib/derivers/html.js";
import { imageDeriver } from "./lib/derivers/image.js";
import { mediaDeriver } from "./lib/derivers/media.js";
import { pdfDeriver } from "./lib/derivers/pdf.js";
import { pptxDeriver } from "./lib/derivers/pptx.js";
import { xlsxDeriver } from "./lib/derivers/xlsx.js";
import { detectFormat } from "./lib/formats.js";
import { docxBytes, pdfBytes, pngBytes, pptxBytes, wavBytes } from "./testing.js";

let root: string;
const fixture = (name: string, bytes: Uint8Array | string): string => {
    const path = join(root, name);
    writeFileSync(path, bytes);
    return path;
};

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fileq-derivers-"));
});
afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("docx", () => {
    test("headings and paragraphs come through as markdown", async () => {
        const path = fixture("plan.docx", docxBytes("Quarterly plan", ["Ship the derivers.", "Then the sweep."]));
        const doc = await docxDeriver.derive(path);
        expect(doc.markdown).toContain("# Quarterly plan");
        expect(doc.markdown).toContain("Ship the derivers.");
    });

    test("magic bytes recognize the container", async () => {
        const path = fixture("plan2.docx", docxBytes("T", ["x"]));
        expect(await detectFormat(path)).toBe("docx");
    });
});

describe("pptx", () => {
    test("one section per slide, in slide order", async () => {
        const path = fixture("deck.pptx", pptxBytes([["Title slide", "A subtitle"], ["Second slide"]]));
        const doc = await pptxDeriver.derive(path);
        expect(doc.markdown).toContain("## Slide 1");
        expect(doc.markdown).toContain("Title slide");
        expect(doc.markdown.indexOf("Second slide")).toBeGreaterThan(doc.markdown.indexOf("A subtitle"));
    });
});

describe("xlsx", () => {
    test("sheets become capped markdown tables", async () => {
        const ExcelJS = (await import("exceljs")).default;
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Costs");
        sheet.addRow(["item", "price"]);
        sheet.addRow(["widget", 4]);
        sheet.addRow(["gadget", 7]);
        const path = join(root, "costs.xlsx");
        await workbook.xlsx.writeFile(path);
        const doc = await xlsxDeriver.derive(path);
        expect(doc.markdown).toContain("## Costs");
        expect(doc.markdown).toContain("| widget | 4 |");
        expect(doc.notes).toEqual([]); // nothing was cut, so nothing claims to be
    });
});

describe("pdf", () => {
    test("the text layer is the markdown", async () => {
        const path = fixture("hello.pdf", pdfBytes("Hello from the text layer of this fixture document"));
        const doc = await pdfDeriver.derive(path);
        expect(doc.markdown).toContain("Hello from the text layer");
        expect(doc.notes).toEqual([]);
    });

    test("a page with no usable text says scan, not silence", async () => {
        const path = fixture("scan.pdf", pdfBytes("x"));
        const doc = await pdfDeriver.derive(path);
        expect(doc.markdown).toBe("");
        expect(doc.notes.join(" ")).toContain("OCR");
    });
});

describe("image", () => {
    test("dimensions land, and the missing caption announces itself as ungenerated", async () => {
        const path = fixture("pixel.png", pngBytes());
        const doc = await imageDeriver.derive(path);
        expect(doc.markdown).toContain("1×1");
        expect(doc.notes.join(" ")).toContain("captioning");
    });
});

describe("media", () => {
    test("duration lands, and the missing transcript announces itself as ungenerated", async () => {
        const path = fixture("silence.wav", wavBytes());
        const doc = await mediaDeriver.derive(path);
        expect(doc.markdown).toContain("Duration: 1s");
        expect(doc.notes.join(" ")).toContain("transcription");
    });
});

describe("html", () => {
    test("webq's writer renders it, title and all", async () => {
        const path = fixture("page.html", "<html><head><title>Local report</title></head><body><h1>Findings</h1><p>All good.</p></body></html>");
        const doc = await htmlDeriver.derive(path);
        expect(doc.title).toBe("Local report");
        expect(doc.markdown).toContain("# Findings");
    });
});
