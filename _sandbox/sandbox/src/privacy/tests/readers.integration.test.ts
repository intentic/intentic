import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { ocrInstalled, ocrModelDir } from "@intentic/ocr/models";
import { loadTextReader } from "@intentic/ocr/paddle-ocr";
import { createLocalReaders } from "../readers.js";
import { installed, pdfWith } from "./pages.testing.js";

// The local readers over the real binaries and models: poppler's pdftotext ships in the image, the PP-OCRv6 models only
// with the privacy pack (and in the CI image), so each case runs where what it needs is and says why where it is not.

// The PDF cases below read a text layer, and need no text reader unless they fall back to reading a page as an image.
const localReaders = () => createLocalReaders({ textReader: () => loadTextReader() });

const poppler = requires(installed("pdftotext") && installed("pdftoppm"), "poppler (pdftotext, pdftoppm) on PATH");
const ocr = requires(ocrInstalled(), `the PP-OCRv6 models at ${ocrModelDir()} (the privacy image pack)`);

test.skipIf(!poppler.runs)(poppler.title("a PDF's text layer is read on this machine"), async () => {
    const text = await localReaders().readPdf(pdfWith("Klient: Jan Kowalski, PESEL 44051401458"));
    expect(text).toContain("Jan Kowalski, PESEL 44051401458");
});

test.skipIf(!poppler.runs)(poppler.title("bytes that are no PDF read as nothing, never as an error"), async () => {
    expect(await localReaders().readPdf(Buffer.from("not a pdf"))).toBeUndefined();
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
