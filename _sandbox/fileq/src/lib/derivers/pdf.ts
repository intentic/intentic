import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { onPath } from "../tools.js";
import type { DerivedDoc, Deriver } from "./deriver.js";

// PDF text layer, per page, via unpdf's serverless pdf.js build (no worker, canvas or DOM shims needed for text
// extraction).
// A scan with no text layer is rasterised and OCR'd when tesseract is on the image, noted as recognised rather than
// exact; otherwise the sidecar says so instead of an empty page.
// Either way, the deterministic tier never guesses at pixels.

// Below this many chars per page, the text layer is furniture, not content: a scan with a vestigial layer.
const SCAN_THRESHOLD_CHARS_PER_PAGE = 24;

// OCR costs seconds per page and runs unasked in the sweep, so a long scan gets its first pages and a note.
const MAX_OCR_PAGES = 20;
const OCR_DPI = "200";

const run = promisify(execFile);

/** Whether this image can recognise a scan: both the rasteriser and the recogniser on PATH. */
export const ocrAvailable = (): boolean => onPath("tesseract") && onPath("pdftoppm");

const recognisePages = async (absPath: string, totalPages: number): Promise<string[]> => {
    const dir = await mkdtemp(join(tmpdir(), "fileq-ocr-"));
    try {
        await run("pdftoppm", ["-r", OCR_DPI, "-png", "-f", "1", "-l", String(Math.min(totalPages, MAX_OCR_PAGES)), absPath, join(dir, "page")], {
            timeout: 120_000,
        });
        const images = (await readdir(dir)).filter((name) => name.endsWith(".png")).toSorted();
        const pages: string[] = [];
        for (const image of images) {
            const { stdout } = await run("tesseract", [join(dir, image), "stdout", "-l", "eng"], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
            pages.push(stdout.replaceAll(/[ \t]+/g, " ").trim());
        }
        return pages;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};

const pagesToMarkdown = (pages: readonly string[]): string =>
    pages.length === 1
        ? (pages[0] ?? "")
        : pages.map((page, index) => `## Page ${index + 1}\n\n${page === "" ? "(no text on this page)" : page}`).join("\n\n");

export const pdfDeriver: Deriver = {
    // The stamp names OCR capability, since a sidecar written before tesseract was available must read as stale now
    // that it's here.
    // A static name would leave a pre-OCR sidecar looking current forever.
    get name(): string {
        return ocrAvailable() ? "pdf+ocr" : "pdf";
    },
    version: 1,
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
                `scanned: text recognised by OCR (tesseract) on ${recognised.length} of ${totalPages} page${plural} — recognised, not exact; check figures against the page image`,
            ];
            if (totalPages > MAX_OCR_PAGES) {
                notes.push(`OCR stops at ${MAX_OCR_PAGES} pages: run tesseract over the rest yourself if they matter`);
            }
            return { markdown: pagesToMarkdown(recognised), title, notes };
        }
        return { markdown: pagesToMarkdown(pages), title, notes: [] };
    },
};
