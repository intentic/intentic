/* Every deriver against a real file its real parser accepts, in a temp tree. What each test pins is the
 * CONTRACT of the derivation — the text is there, the caps and degradations announce themselves — never the
 * parser's formatting details, which belong to the libraries. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { docxDeriver } from "./lib/derivers/docx.js";
import { epubDeriver } from "./lib/derivers/epub.js";
import { htmlDeriver } from "./lib/derivers/html.js";
import { imageDeriver } from "./lib/derivers/image.js";
import { ipynbDeriver } from "./lib/derivers/ipynb.js";
import { mediaDeriver } from "./lib/derivers/media.js";
import { odfToHtml, odtDeriver } from "./lib/derivers/odt.js";
import { ocrAvailable, pdfDeriver } from "./lib/derivers/pdf.js";
import { pptxDeriver } from "./lib/derivers/pptx.js";
import { xlsxDeriver } from "./lib/derivers/xlsx.js";
import { detectFormat } from "./lib/formats.js";
import { docxBytes, epubBytes, ipynbText, odtBytes, pdfBytes, pngBytes, pptxBytes, wavBytes } from "./testing.js";

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

    test("a page with no usable text says scan, not silence (no tesseract on PATH)", async () => {
        const path = fixture("scan.pdf", pdfBytes("x"));
        const previousPath = process.env["PATH"];
        process.env["PATH"] = "/nonexistent";
        try {
            expect(pdfDeriver.name).toBe("pdf");
            const doc = await pdfDeriver.derive(path);
            expect(doc.markdown).toBe("");
            expect(doc.notes.join(" ")).toContain("OCR is not part of this tier");
        } finally {
            process.env["PATH"] = previousPath;
        }
    });

    /* The OCR tier, exercised for real where the image carries tesseract + poppler (an extension's layer). The
     * scan is built by Pillow — baked in the sandbox — from a TTF so the glyphs are large enough to recognise;
     * the sentence is chosen to survive OCR without a dictionary. */
    const DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
    test.skipIf(!ocrAvailable() || !existsSync(DEJAVU))("a scan is recognised by tesseract when the image carries it, and says so", async () => {
        const path = join(root, "receipt.pdf");
        execFileSync("python3", [
            "-c",
            [
                "import sys",
                "from PIL import Image, ImageDraw, ImageFont",
                "img = Image.new('RGB', (1400, 300), 'white')",
                `ImageDraw.Draw(img).text((40, 100), 'TOTAL DUE 1845 DOLLARS', fill='black', font=ImageFont.truetype(sys.argv[2], 72))`,
                "img.save(sys.argv[1], resolution=200.0)",
            ].join("\n"),
            path,
            DEJAVU,
        ]);
        expect(pdfDeriver.name).toBe("pdf+ocr");
        const doc = await pdfDeriver.derive(path);
        expect(doc.markdown).toMatch(/TOTAL DUE 1845/);
        expect(doc.notes.join(" ")).toContain("recognised, not exact");
    });
});

describe("ipynb", () => {
    test("markdown cells pass through, code is fenced in the kernel language, text outputs follow, rich ones are counted", async () => {
        const path = fixture("analysis.ipynb", ipynbText("Churn analysis", "print(df.shape)", ["(1200, 14)"]));
        const doc = await ipynbDeriver.derive(path);
        expect(doc.title).toBe("Churn analysis");
        expect(doc.markdown).toContain("# Churn analysis");
        expect(doc.markdown).toContain("```python\nprint(df.shape)\n```");
        expect(doc.markdown).toContain("(1200, 14)");
        expect(doc.markdown).toContain("[image/png output omitted]");
        expect(doc.notes.join(" ")).toContain("1 rich output");
    });

    test("a runaway output is cut at the cap and the cut is announced", async () => {
        const path = fixture(
            "loop.ipynb",
            ipynbText(
                "Loop",
                "for i in range(100): print(i)",
                Array.from({ length: 100 }, (_, i) => String(i)),
            ),
        );
        const doc = await ipynbDeriver.derive(path);
        // 100 stream lines plus the fixture's one rich-output marker: 101 lines, 40 kept.
        expect(doc.markdown).toContain("… 61 more output lines");
        expect(doc.notes.join(" ")).toContain("output cut at 40 lines");
    });

    test("the extension is the recognition: JSON has no magic", async () => {
        expect(await detectFormat(fixture("nb.ipynb", ipynbText("T", "x", [])))).toBe("ipynb");
    });
});

describe("odt", () => {
    test("headings, paragraphs, lists and tables come through webq's writer; comments do not", async () => {
        const path = fixture("letter.odt", odtBytes("Notice of intent", ["We will ship the derivers.", "Then the sweep."]));
        expect(await detectFormat(path)).toBe("odt");
        const doc = await odtDeriver.derive(path);
        expect(doc.title).toBe("Notice of intent");
        expect(doc.markdown).toContain("# Notice of intent");
        expect(doc.markdown).toContain("We will ship the derivers.");
        expect(doc.markdown).toMatch(/^- first item$/m);
        expect(doc.markdown).toMatch(/^- second item$/m); // <text:s text:c="2"/> became spaces, which the writer collapses like any HTML
        expect(doc.markdown).toMatch(/\| cell a \| cell b \|/);
        expect(doc.markdown).not.toContain("reviewer's comment");
    });

    test("the ODF → HTML rewrite unwraps what it does not name rather than swallowing it", () => {
        const html = odfToHtml(
            '<office:text><text:section text:name="s"><text:p>kept <text:span text:style-name="T1">inline</text:span></text:p></text:section><text:soft-page-break/><text:h text:outline-level="2">Two</text:h></office:text>',
        );
        expect(html).toBe("<p>kept <span>inline</span></p><h2>Two</h2>");
    });
});

describe("epub", () => {
    test("chapters land in spine order under their own headings; the nav document is not a chapter", async () => {
        const path = fixture(
            "novel.epub",
            epubBytes("A Fixture Novel", [
                { title: "Chapter One", body: "It was a dark and stormy fixture." },
                { title: "Chapter Two", body: "The derivers were tested." },
            ]),
        );
        expect(await detectFormat(path)).toBe("epub");
        const doc = await epubDeriver.derive(path);
        expect(doc.title).toBe("A Fixture Novel");
        expect(doc.markdown).toContain("# Chapter One");
        expect(doc.markdown.indexOf("The derivers were tested.")).toBeGreaterThan(doc.markdown.indexOf("stormy fixture"));
        expect(doc.markdown).not.toContain("Contents");
        expect(doc.notes).toEqual([]);
    });

    test("a zip that is not really an EPUB says what is missing", async () => {
        const { strToU8, zipSync } = await import("fflate");
        const path = fixture("hollow.epub", zipSync({ mimetype: [strToU8("application/epub+zip"), { level: 0 }], "a.txt": strToU8("x") }));
        const doc = await epubDeriver.derive(path);
        expect(doc.markdown).toBe("");
        expect(doc.notes.join(" ")).toContain("container.xml");
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
