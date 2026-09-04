import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { onPath } from "../tools.js";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* PDFs: the text layer, per page. unpdf over pdfjs-dist directly because it ships a serverless pdf.js build
 * that runs in plain Node with no worker, no canvas and no DOM shims — the exact subset text extraction
 * needs, at a fraction of the install.
 *
 * A PDF with no text layer (a scan) is the honesty case this deriver exists to get right. When the image
 * carries tesseract (an extension's layer puts it there; the core image does not), the scan is rasterised
 * and recognised, page by page and capped, and the sidecar says the words are recognised rather than
 * exact. When it does not, the sidecar says so instead of producing an empty page that reads as an empty
 * document. Either way the deterministic tier never guesses at pixels. */

// Below this many characters per page on average the "text layer" is furniture (page numbers, a watermark),
// not content — the tell of a scanned document with a vestigial layer.
const SCAN_THRESHOLD_CHARS_PER_PAGE = 24;

// OCR is the one derivation here that costs seconds per page, and it runs unasked in the background sweep,
// so a 400-page scanned ledger gets its first pages recognised and a note naming the rest.
const MAX_OCR_PAGES = 20;
const OCR_DPI = "200";

const run = promisify(execFile);

/** Whether this image can recognise a scan: both halves, the rasteriser and the recogniser, on PATH. */
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
    /* The stamp is part of the deriver's identity, and OCR is part of what this deriver produces — so a
     * sidecar written for a scan before tesseract arrived (an owner approving an extension's layer and
     * rebuilding) must read as stale the moment it is here. Naming the capability in the stamp is what makes
     * the next touch re-derive it; a static name would leave "OCR is not part of this tier" on disk forever. */
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
