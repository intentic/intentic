import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { ocrInstalled, ocrModelDir } from "@intentic/ocr/models";
import { loadTextReader } from "@intentic/ocr/paddle-ocr";
import { createLocalReaders } from "../readers.js";
import { installed, pdfWith } from "./pages.testing.js";

// The local readers over the real binaries and models: poppler and the PP-OCRv6 models come with the privacy pack (and
// are in the CI image), fileq with the image, so each case runs where what it needs is and says why where it is not.

const poppler = requires(installed("pdftotext") && installed("pdftoppm"), "poppler (pdftotext, pdftoppm) on PATH");
const ocr = requires(ocrInstalled(), `the PP-OCRv6 models at ${ocrModelDir()} (the privacy image pack)`);

// Text-layer only: no text reader, so nothing on the page is read off its picture.
const layerReaders = () => createLocalReaders({ textReader: async () => undefined, installed: () => false });

test.skipIf(!poppler.runs)(poppler.title("a PDF's pages are drawn here, its text layer placed on them in their pixels"), async () => {
    const pdf = pdfWith("Klient: Jan Kowalski, PESEL 44051401458");
    const reading = await layerReaders().readPdf(pdf);
    // The page is 612 x 792 points, two pixels to the point.
    expect(reading?.pages.map((page) => [page.width, page.height])).toEqual([[1224, 1584]]);
    expect(reading?.pixels).toBe(false);
    const [line] = reading?.pages[0]?.lines ?? [];
    expect(line?.text).toBe("Klient: Jan Kowalski, PESEL 44051401458");
    // Drawn at 72 points from the left, 18 points tall: 144 pixels in, near the top.
    expect(line?.corners[0].x).toBeCloseTo(144, 0);
    expect(line?.corners[0].y).toBeLessThan(200);
    const drawn = await layerReaders().drawPdf(pdf);
    expect(drawn?.map((page) => page.subarray(0, 2).toString("hex"))).toEqual(["ffd8"]);
});

test.skipIf(!poppler.runs || !ocr.runs)(ocr.title("with the text reader, a page's text layer is not read again off its picture"), async () => {
    const reader = await loadTextReader();
    try {
        const reading = await createLocalReaders({ textReader: async () => reader }).readPdf(pdfWith("Klient: Jan Kowalski, PESEL 44051401458"));
        expect(reading?.pixels).toBe(true);
        expect(reading?.pages[0]?.lines.map((line) => line.text)).toEqual(["Klient: Jan Kowalski, PESEL 44051401458"]);
    } finally {
        await reader?.release();
    }
});

test("plain text is read as it is, and bytes that are no text are not", async () => {
    const readers = layerReaders();
    expect(await readers.readDocument(Buffer.from("Klient: Jan Kowalski"), "text/csv; charset=utf-8")).toBe("Klient: Jan Kowalski");
    expect(await readers.readDocument(Buffer.from('{"pesel":"44051401458"}'), "application/json")).toContain("44051401458");
    expect(await readers.readDocument(Buffer.from([0, 1, 2, 3]), "text/plain")).toBeUndefined();
    expect(await readers.readDocument(Buffer.from("MZ"), "application/x-msdownload")).toBeUndefined();
});

const fileq = requires(installed("fileq"), "fileq on PATH");

test.skipIf(!fileq.runs)(fileq.title("an office document is read through fileq, and leaves nothing behind"), async () => {
    const rtf = Buffer.from("{\\rtf1\\ansi Klient: Jan Kowalski, PESEL 44051401458\\par}", "latin1");
    expect(await layerReaders().readDocument(rtf, "application/rtf")).toContain("Jan Kowalski, PESEL 44051401458");
});

test.skipIf(!poppler.runs)(poppler.title("bytes that are no PDF read as nothing, never as an error"), async () => {
    expect(await layerReaders().readPdf(Buffer.from("not a pdf"))).toBeUndefined();
    expect(await layerReaders().drawPdf(Buffer.from("not a pdf"))).toBeUndefined();
});

// The page drawn to an image is what a screenshot of a document is; reading it back is what masking an image starts with.
test.skipIf(!poppler.runs || !ocr.runs)(ocr.title("an image's text is read on this machine, line by line with where it sits"), async () => {
    const dir = await mkdtemp(join(tmpdir(), "privacy-ocr-"));
    // Released at the end: its model sessions are native memory that the one process every integration file of the
    // package runs in would otherwise hold to the end of the run.
    const reader = await loadTextReader();
    try {
        await writeFile(join(dir, "page.pdf"), pdfWith("Klient Jan Kowalski"));
        execFileSync("pdftoppm", ["-r", "200", "-png", "-singlefile", join(dir, "page.pdf"), join(dir, "page")]);
        const readers = createLocalReaders({ textReader: async () => reader });
        expect(await readers.ocr()).toBe(true);
        const reading = await readers.readImage(await readFile(join(dir, "page.png")));
        // Drawn at 200 dpi on US Letter, the page is 1700 x 2200 and its one line sits in its upper left.
        expect(reading).toMatchObject({ width: 1700, height: 2200 });
        expect(reading?.lines).toHaveLength(1);
        const [line] = reading?.lines ?? [];
        expect(Math.max(...(line?.corners.map((point) => point.y) ?? []))).toBeLessThan(300);
        expect(line?.text).toContain("Kowalski");
    } finally {
        await reader?.release();
        await rm(dir, { recursive: true, force: true });
    }
});
