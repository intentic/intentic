import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execBounded, ProcessError } from "@intentic/base/process";
import { getDocumentProxy, getMeta } from "unpdf";
import { runInOcrSlot } from "../ocr-slots.js";
import { onPath } from "../tools.js";
import type { DerivedDoc, Deriver } from "./deriver.js";
import { stripRunningFurniture } from "./pdf-furniture.js";
import { pageText } from "./pdf-tables.js";

// PDF text layer, per page, via unpdf's serverless pdf.js build (no worker, canvas or DOM shims needed for text
// extraction).
// A scan with no text layer is rasterised and OCR'd when an `ocr` command can read (the Intentic sandbox's own text
// reader, PaddleOCR's PP-OCRv6 run on this machine, whose models its privacy image pack brings), noted as recognised
// rather than exact; otherwise the sidecar says so instead of an empty page.
// Either way, the deterministic tier never guesses at pixels.

// Below this many chars per page, the text layer is furniture, not content: a scan with a vestigial layer.
const SCAN_THRESHOLD_CHARS_PER_PAGE = 24;

// OCR costs seconds per page, so a long scan gets its first pages and a note. Someone reading now gets 20; the daemon's
// shadow keeper, working in the background with nobody waiting, asks for more (`fileq derive --ocr-pages 500`, which
// sets FILEQ_OCR_PAGES for the run).
const DEFAULT_OCR_PAGES = 20;
const MAX_OCR_PAGES = 5000;
const OCR_DPI = "200";
// Pages drawn and read this many at a time. The drawings on disk stay one chunk's worth (all 500 at once were about
// 900 MB of PNG in /tmp), each reader process ends after its chunk, and the machine's OCR slot (ocr-slots.ts) is let
// go between chunks, so a read waiting behind a 500-page scan waits for one chunk of it. Starting a reader costs about
// half a second against several seconds a page.
const OCR_CHUNK_PAGES = 8;

/** How many pages of a scan this run recognises: FILEQ_OCR_PAGES when it is a sane count, else 20. */
export const ocrPageCap = (): number => {
    const asked = Number(process.env["FILEQ_OCR_PAGES"]);
    return Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_OCR_PAGES) : DEFAULT_OCR_PAGES;
};

// The note a capped recognition leaves; ocrCapOf (sidecar.ts) reads the cap back off it.
const capNote = (cap: number): string => `OCR stops at ${cap} pages: draw the rest with pdftoppm and read them with \`ocr <page.png>...\` if they matter`;

// The reader loads its models once per run and then takes a second or few per page.
const ocrTimeoutMs = (pages: number): number => 60_000 + pages * 15_000;

// Asked once per PATH: the answer is a fact of the image, and a stamp is read on every derive.
const checked = new Map<string, boolean>();

/**
 * Whether this machine can recognise a scan: the rasteriser on PATH, and an `ocr` that says it can read (`ocr --check`
 * exits 0). The sandbox image carries the command on every box and its models only with the privacy pack, so being on
 * PATH alone proves nothing.
 */
export const ocrAvailable = (): boolean => {
    const path = process.env["PATH"] ?? "";
    let available = checked.get(path);
    if (available === undefined) {
        available = onPath("pdftoppm") && onPath("ocr") && spawnSync("ocr", ["--check"], { stdio: "ignore", timeout: 10_000 }).status === 0;
        checked.set(path, available);
    }
    return available;
};

// What `ocr` printed for its images, one page per image: it writes a form feed line between images, and an image it
// could not read leaves its page empty (exit 1) rather than shifting the ones after it. The pages are split on those
// form feeds, so the cap stays well past what a chunk of pages comes to: a cut middle would shift every page after it.
const readPages = async (images: readonly string[]): Promise<string> => {
    const result = await runInOcrSlot("ocr", images, { timeoutMs: ocrTimeoutMs(images.length), maxOutput: 64 * 1024 * 1024 });
    if (!result.timedOut && (result.exitCode === 0 || result.exitCode === 1)) {
        return result.stdout.text;
    }
    throw new ProcessError("ocr", images, result);
};

// The page a drawing is of, off the number pdftoppm puts in its name (`page-07.tif`).
const pageNumberOf = (image: string): number => Number(/-(\d+)\.tif$/.exec(image)?.[1] ?? Number.NaN);

// Pages `first` to `last` drawn and read, one entry per page whether or not it could be drawn, and the drawings
// removed. TIFF with PackBits is as lossless as PNG, so the reader sees the same pixels and reads the same text, but
// pdftoppm writes it about twelve times faster: PNG's compression cost 0.85 s a page at 200 dpi (measured 2026-11-23).
const recogniseChunk = async (absPath: string, dir: string, first: number, last: number): Promise<string[]> => {
    const prefix = join(dir, "page");
    await execBounded("pdftoppm", ["-r", OCR_DPI, "-tiff", "-tiffcompression", "packbits", "-f", String(first), "-l", String(last), absPath, prefix], {
        timeoutMs: 60_000 + (last - first + 1) * 2_000,
    });
    const images = (await readdir(dir)).filter((name) => name.endsWith(".tif")).toSorted((a, b) => pageNumberOf(a) - pageNumberOf(b));
    try {
        const text = images.length === 0 ? [] : (await readPages(images.map((image) => join(dir, image)))).split("\f");
        const pages = Array.from({ length: last - first + 1 }, () => "");
        for (const [index, image] of images.entries()) {
            const page = pageNumberOf(image) - first;
            if (page >= 0 && page < pages.length) {
                pages[page] = (text[index] ?? "").replaceAll(/[ \t]+/g, " ").trim();
            }
        }
        return pages;
    } finally {
        await Promise.all(images.map((image) => rm(join(dir, image), { force: true })));
    }
};

const recognisePages = async (absPath: string, totalPages: number, cap: number): Promise<string[]> => {
    const dir = await mkdtemp(join(tmpdir(), "fileq-ocr-"));
    const last = Math.min(totalPages, cap);
    try {
        const pages: string[] = [];
        for (let first = 1; first <= last; first += OCR_CHUNK_PAGES) {
            pages.push(...(await recogniseChunk(absPath, dir, first, Math.min(last, first + OCR_CHUNK_PAGES - 1))));
        }
        return pages;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

// Each page's text, one page at a time and each let go once read: unpdf's extractText asks for every page at once,
// and pdf.js holds them all until the end (a 5000-page text pdf peaked at 699 MB that way, 286 MB this way). A page's
// items are joined in drawing order, its column-aligned regions as markdown tables (pdf-tables.ts).
const pageTexts = async (pdf: PdfDocument): Promise<string[]> => {
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        pages.push(pageText(content.items.filter((item) => "str" in item)));
        page.cleanup();
    }
    return pages;
};

const pagesToMarkdown = (pages: readonly string[]): string =>
    pages.length === 1
        ? (pages[0] ?? "")
        : pages.map((page, index) => `## Page ${index + 1}\n\n${page === "" ? "(no text on this page)" : page}`).join("\n\n");

// Every stripped line is named in a note, since a reader comparing against the page image should know what went.
const furnitureNotes = (removed: number, example: string | undefined): string[] =>
    removed === 0
        ? []
        : [
              `removed ${removed} running header, footer and page-number line${removed === 1 ? "" : "s"}${example === undefined ? "" : ` (such as "${example}")`}`,
          ];

const withoutFurniture = (pages: readonly string[]): { markdown: string; notes: string[] } => {
    const { pages: kept, removed, example } = stripRunningFurniture(pages);
    return { markdown: pagesToMarkdown(kept), notes: furnitureNotes(removed, example) };
};

const derivePdf = async (absPath: string, pdf: PdfDocument): Promise<DerivedDoc> => {
    const totalPages = pdf.numPages;
    const pages = await pageTexts(pdf);
    const meta = await getMeta(pdf).catch(() => undefined);
    const info = meta?.info as Record<string, unknown> | undefined;
    const title = typeof info?.["Title"] === "string" && info["Title"] !== "" ? info["Title"] : undefined;
    const totalChars = pages.reduce((sum, page) => sum + page.length, 0);
    if (totalChars < SCAN_THRESHOLD_CHARS_PER_PAGE * totalPages) {
        const plural = totalPages === 1 ? "" : "s";
        if (!ocrAvailable()) {
            return {
                markdown: "",
                title,
                notes: [`no usable text layer across ${totalPages} page${plural} (a scan?): OCR is not part of this tier`],
            };
        }
        const cap = ocrPageCap();
        const recognised = await recognisePages(absPath, totalPages, cap);
        const notes = [
            `scanned: text recognised by OCR (PaddleOCR) on ${recognised.length} of ${totalPages} page${plural} — recognised, not exact; check figures against the page image`,
        ];
        if (totalPages > cap) {
            notes.push(capNote(cap));
        }
        const { markdown, notes: stripped } = withoutFurniture(recognised);
        return { markdown, title, notes: [...notes, ...stripped] };
    }
    return { title, ...withoutFurniture(pages) };
};

export const pdfDeriver: Deriver = {
    // The stamp names OCR capability, since a sidecar written before the reader was available must read as stale now
    // that it's here. A static name would leave a pre-OCR sidecar looking current forever. It names the reader too:
    // `pdf+ocr` was tesseract's, whose pages PaddleOCR reads again.
    get name(): string {
        return ocrAvailable() ? "pdf+ppocr" : "pdf";
    },
    version: 3,
    derive: async (absPath): Promise<DerivedDoc> => {
        const pdf = await getDocumentProxy(new Uint8Array(await readFile(absPath)));
        // One fileq run derives a batch of files, so each document is let go before the next.
        try {
            return await derivePdf(absPath, pdf);
        } finally {
            await pdf.loadingTask.destroy();
        }
    },
};
