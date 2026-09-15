/* Every deriver against a real file its real parser accepts, in a temp tree. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { archiveDeriver } from "./lib/derivers/archive.js";
import { docxDeriver } from "./lib/derivers/docx.js";
import { epubDeriver } from "./lib/derivers/epub.js";
import { htmlDeriver } from "./lib/derivers/html.js";
import { imageDeriver } from "./lib/derivers/image.js";
import { ipynbDeriver } from "./lib/derivers/ipynb.js";
import { mediaDeriver } from "./lib/derivers/media.js";
import { odpDeriver } from "./lib/derivers/odp.js";
import { odsDeriver } from "./lib/derivers/ods.js";
import { odfToHtml, odtDeriver } from "./lib/derivers/odt.js";
import { ocrAvailable, pdfDeriver } from "./lib/derivers/pdf.js";
import { pptxDeriver } from "./lib/derivers/pptx.js";
import { rtfDeriver, rtfParagraphs } from "./lib/derivers/rtf.js";
import { xlsxDeriver } from "./lib/derivers/xlsx.js";
import { detectFormat } from "./lib/formats.js";
import { docxBytes, epubBytes, gzipBytes, ipynbText, odpBytes, odsBytes, odtBytes, pdfBytes, pngBytes, pptxBytes, rtfBytes, tarBytes, wavBytes, zipBytes } from "./testing.js";

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

/* The OCR tier, exercised for real where the image carries tesseract + poppler (an extension's layer). */
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

describe("ods", () => {
    test("each sheet becomes a markdown table, without the padding ODF fills a sheet out with", async () => {
        const path = fixture(
            "budget.ods",
            odsBytes([
                { name: "Q1", rows: [["Item", "Cost"], ["Paper", "12"]] },
                { name: "Q2", rows: [["Item", "Cost"]] },
            ]),
        );
        expect(await detectFormat(path)).toBe("ods");
        const doc = await odsDeriver.derive(path);
        expect(doc.markdown).toContain("## Q1");
        expect(doc.markdown).toMatch(/\| Item \| Cost \|/);
        expect(doc.markdown).toMatch(/\| Paper \| 12 \|/);
        expect(doc.markdown).toContain("## Q2");
        // A real sheet carries a thousand repeated empty cells and a million empty rows after its data.
        expect(doc.markdown).not.toMatch(/\|\s+\|\s+\|\s+\|/);
        expect(doc.notes).toEqual([]);
    });
});

describe("odp", () => {
    test("each page becomes a slide section, with the speaker's notes quoted under it", async () => {
        const path = fixture(
            "pitch.odp",
            odpBytes([
                { name: "Title", lines: ["Our plan", "In three parts"], note: "Smile here." },
                { name: "Detail", lines: ["Part one"] },
            ]),
        );
        expect(await detectFormat(path)).toBe("odp");
        const doc = await odpDeriver.derive(path);
        expect(doc.markdown).toContain("## Slide 1: Title");
        expect(doc.markdown).toContain("In three parts");
        expect(doc.markdown).toContain("> Smile here.");
        expect(doc.markdown).toContain("## Slide 2: Detail");
        // The note belongs to the slide that carries it, not to the next one.
        expect(doc.markdown.indexOf("> Smile here.")).toBeLessThan(doc.markdown.indexOf("## Slide 2"));
    });
});

describe("rtf", () => {
    test("paragraphs and table cells come through; the font table and an ignorable group do not", async () => {
        const path = fixture("memo.rtf", rtfBytes(["A plain paragraph.", "Another one."]));
        expect(await detectFormat(path)).toBe("rtf");
        const doc = await rtfDeriver.derive(path);
        expect(doc.markdown).toContain("A plain paragraph.");
        expect(doc.markdown).toContain("Another one.");
        expect(doc.markdown).toContain("left | right");
        expect(doc.markdown).not.toContain("Times New Roman");
        expect(doc.markdown).not.toContain("Not text");
    });

    test("reads a byte through the code page and a \\u escape without its fallback character", () => {
        expect(rtfParagraphs(`{\\rtf1\\ansi caf\\'e9 \\u233?\\par}`)).toEqual(["café é"]);
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

describe("archive", () => {
    test("a zip's shadow is its manifest, and says the members' contents are not in it", async () => {
        const path = fixture("bundle.zip", zipBytes({ "README.md": "# Bundle", "src/app.ts": "export const go = () => 1;\n".repeat(30) }));
        const doc = await archiveDeriver.derive(path);
        expect(doc.markdown).toContain("- Archive: zip");
        expect(doc.markdown).toContain("- Members: 2 files");
        expect(doc.markdown).toContain("| src/app.ts |");
        expect(doc.markdown).not.toContain("export const go");
        expect(doc.notes.join(" ")).toContain("member listing only");
    });

    test("magic routes a zip to the archive deriver while a docx stays a document", async () => {
        expect(await detectFormat(fixture("bundle2.zip", zipBytes({ "a.txt": "a" })))).toBe("archive");
        expect(await detectFormat(fixture("report.docx", docxBytes("T", ["x"])))).toBe("docx");
    });

    test("a renamed archive is recognized by its bytes, not its name", async () => {
        expect(await detectFormat(fixture("mystery.bin", zipBytes({ "a.txt": "a" })))).toBe("archive");
    });

    test("a tar lists members in archive order", async () => {
        const path = fixture("backup.tar", tarBytes({ "notes.txt": "hello", "data/rows.csv": "a,b\n1,2\n" }));
        const doc = await archiveDeriver.derive(path);
        expect(doc.markdown).toContain("- Archive: tar");
        expect(doc.markdown.indexOf("notes.txt")).toBeLessThan(doc.markdown.indexOf("data/rows.csv"));
    });

    test("a gzipped tar is listed as the tar inside it", async () => {
        const path = fixture("release.tgz", gzipBytes("release.tar", tarBytes({ "bin/tool": "#!/bin/sh\n" })));
        const doc = await archiveDeriver.derive(path);
        expect(doc.markdown).toContain("| bin/tool |");
        expect(doc.notes.join(" ")).toContain("gzip-compressed tar");
    });

    test("a single compressed file carries its text, since there the archive is the document", async () => {
        const path = fixture("server.log.gz", gzipBytes("server.log", "GET /健康 200\nGET /orders 500\n"));
        const doc = await archiveDeriver.derive(path);
        expect(doc.markdown).toContain("- Member: server.log");
        expect(doc.markdown).toContain("GET /orders 500");
    });

    test("a compressed binary says so instead of printing bytes", async () => {
        const path = fixture("pixel.png.gz", gzipBytes("pixel.png", pngBytes()));
        const doc = await archiveDeriver.derive(path);
        expect(doc.markdown).not.toContain("PNG");
        expect(doc.notes.join(" ")).toContain("not text");
    });

    test("an empty archive says it holds nothing rather than reading as one", async () => {
        const doc = await archiveDeriver.derive(fixture("empty.zip", zipBytes({})));
        expect(doc.notes.join(" ")).toContain("holds nothing");
    });

    test("a file that is no archive at all fails loudly", async () => {
        await expect(archiveDeriver.derive(fixture("notes.zip", "plain text wearing a zip extension"))).rejects.toThrow(/not an archive/);
    });
});
