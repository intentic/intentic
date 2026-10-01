import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { onPath } from "../tools.js";
import type { DerivedDoc, Deriver } from "./deriver.js";
import { stripRunningFurniture } from "./pdf-furniture.js";

// PDF text layer, per page, via unpdf's serverless pdf.js build (no worker, canvas or DOM shims needed for text
// extraction).
// A scan with no text layer is rasterised and OCR'd when an `ocr` command can read (the Intentic sandbox's own text
// reader, PaddleOCR's PP-OCRv6 run on this machine, whose models its privacy image pack brings), noted as recognised
// rather than exact; otherwise the sidecar says so instead of an empty page.
// Either way, the deterministic tier never guesses at pixels.

// Below this many chars per page, the text layer is furniture, not content: a scan with a vestigial layer.
const SCAN_THRESHOLD_CHARS_PER_PAGE = 24;

// OCR costs seconds per page, so a long scan gets its first pages and a note.
const MAX_OCR_PAGES = 20;
const OCR_DPI = "200";
// The reader loads its models once per run and then takes a second or few per page.
const OCR_TIMEOUT_MS = 60_000 + MAX_OCR_PAGES * 15_000;

const run = promisify(execFile);

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
// could not read leaves its page empty (exit 1) rather than shifting the ones after it.
const readPages = (images: readonly string[]): Promise<string> =>
    new Promise((resolve, reject) => {
        execFile("ocr", [...images], { timeout: OCR_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
            if (error === null || error.code === 1) {
                resolve(stdout);
            } else {
                reject(error);
            }
        });
    });

const recognisePages = async (absPath: string, totalPages: number): Promise<string[]> => {
    const dir = await mkdtemp(join(tmpdir(), "fileq-ocr-"));
    try {
        await run("pdftoppm", ["-r", OCR_DPI, "-png", "-f", "1", "-l", String(Math.min(totalPages, MAX_OCR_PAGES)), absPath, join(dir, "page")], {
            timeout: 120_000,
        });
        const images = (await readdir(dir)).filter((name) => name.endsWith(".png")).toSorted();
        if (images.length === 0) {
            return [];
        }
        // One run for every page, so the models load once.
        const pages = (await readPages(images.map((image) => join(dir, image)))).split("\f");
        return images.map((_, index) => (pages[index] ?? "").replaceAll(/[ \t]+/g, " ").trim());
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
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

export const pdfDeriver: Deriver = {
    // The stamp names OCR capability, since a sidecar written before the reader was available must read as stale now
    // that it's here. A static name would leave a pre-OCR sidecar looking current forever. It names the reader too:
    // `pdf+ocr` was tesseract's, whose pages PaddleOCR reads again.
    get name(): string {
        return ocrAvailable() ? "pdf+ppocr" : "pdf";
    },
    version: 2,
    derive: async (absPath): Promise<DerivedDoc> => {
        const pdf = await getDocumentProxy(new Uint8Array(await readFile(absPath)));
        const { totalPages, text } = await extractText(pdf, { mergePages: false });
        const meta = await getMeta(pdf).catch(() => undefined);
        const info = meta?.info as Record<string, unknown> | undefined;
        const title = typeof info?.["Title"] === "string" && info["Title"] !== "" ? info["Title"] : undefined;
        const pages = text.map((page) => page.replaceAll(/[ \t]+/g, " ").trim());
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
            const recognised = await recognisePages(absPath, totalPages);
            const notes = [
                `scanned: text recognised by OCR (PaddleOCR) on ${recognised.length} of ${totalPages} page${plural} — recognised, not exact; check figures against the page image`,
            ];
            if (totalPages > MAX_OCR_PAGES) {
                notes.push(`OCR stops at ${MAX_OCR_PAGES} pages: draw the rest with pdftoppm and read them with \`ocr <page.png>...\` if they matter`);
            }
            const { markdown, notes: stripped } = withoutFurniture(recognised);
            return { markdown, title, notes: [...notes, ...stripped] };
        }
        return { title, ...withoutFurniture(pages) };
    },
};
