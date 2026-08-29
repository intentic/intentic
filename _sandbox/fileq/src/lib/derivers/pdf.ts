import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* PDFs: the text layer, per page. unpdf over pdfjs-dist directly because it ships a serverless pdf.js build
 * that runs in plain Node with no worker, no canvas and no DOM shims — the exact subset text extraction
 * needs, at a fraction of the install.
 *
 * A PDF with no text layer (a scan) is the honesty case this deriver exists to get right: it says so, in the
 * sidecar and the capsule, instead of producing an empty page that reads as an empty document. OCR is a
 * later, tesseract-backed tier — the deterministic tier refuses to guess at pixels. */

// Below this many characters per page on average the "text layer" is furniture (page numbers, a watermark),
// not content — the tell of a scanned document with a vestigial layer.
const SCAN_THRESHOLD_CHARS_PER_PAGE = 24;

export const pdfDeriver: Deriver = {
    name: "pdf",
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
            return {
                markdown: "",
                title,
                notes: [`no usable text layer across ${totalPages} page${totalPages === 1 ? "" : "s"} (a scan?): OCR is not part of this tier`],
            };
        }
        const markdown =
            totalPages === 1
                ? (pages[0] ?? "")
                : pages.map((page, index) => `## Page ${index + 1}\n\n${page === "" ? "(no text on this page)" : page}`).join("\n\n");
        return { markdown, title, notes: [] };
    },
};
