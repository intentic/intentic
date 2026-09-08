import { extname } from "node:path";
import { fileTypeFromFile } from "file-type";

// Which files fileq can turn into markdown, shared by the CLI (routes on it) and the daemon (its cheap pre-filter), so
// the two can never disagree about what's derivable.
// Recognition mirrors the daemon's workspace classifier: magic bytes first, extension as fallback for formats magic
// can't see (.html has no signature).
// Magic wins over a lying extension both ways: a renamed docx still derives, a fake .docx is refused rather than
// mis-parsed.

export type Format = "docx" | "xlsx" | "pptx" | "pdf" | "image" | "media" | "html" | "ipynb" | "odt" | "epub";

// file-type's ext per container to its format; preferred over sniffing zip since it names OOXML/ODF/EPUB.
const MAGIC_FORMAT: Record<string, Format> = {
    docx: "docx",
    xlsx: "xlsx",
    pptx: "pptx",
    odt: "odt",
    epub: "epub",
    pdf: "pdf",
    png: "image",
    jpg: "image",
    gif: "image",
    webp: "image",
    tif: "image",
    heic: "image",
    avif: "image",
    mp3: "media",
    wav: "media",
    flac: "media",
    ogg: "media",
    opus: "media",
    aac: "media",
    m4a: "media",
    mp4: "media",
    mov: "media",
    webm: "media",
    mkv: "media",
};

// Extension to format, for magic-blind files (html) and as a pre-filter before a magic read.
export const EXTENSION_FORMAT: Record<string, Format> = {
    ".docx": "docx",
    ".xlsx": "xlsx",
    ".pptx": "pptx",
    ".odt": "odt",
    ".epub": "epub",
    ".ipynb": "ipynb", // JSON: no magic bytes name it, so the extension is the whole recognition.
    ".pdf": "pdf",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".gif": "image",
    ".webp": "image",
    ".tif": "image",
    ".tiff": "image",
    ".heic": "image",
    ".avif": "image",
    ".mp3": "media",
    ".wav": "media",
    ".flac": "media",
    ".ogg": "media",
    ".opus": "media",
    ".aac": "media",
    ".m4a": "media",
    ".mp4": "media",
    ".mov": "media",
    ".webm": "media",
    ".mkv": "media",
    ".html": "html",
    ".htm": "html",
};

/** Cheap pre-filter: could this path, by name alone, have a derivable format? Runs over every watcher batch. */
export const isCandidatePath = (path: string): boolean => extname(path).toLowerCase() in EXTENSION_FORMAT;

// Zip-underneath formats where magic can only say "zip"; the extension names the real container instead.
const ZIP_CONTAINERS: ReadonlySet<Format> = new Set(["docx", "xlsx", "pptx", "odt", "epub"]);

/**
 * Magic bytes first, extension only when magic says nothing or just "zip" where the extension claims an OOXML
 * container.
 * A magic verdict for a format not derived here answers undefined rather than falling back to a lying extension.
 */
export const detectFormat = async (absPath: string): Promise<Format | undefined> => {
    const byExtension = EXTENSION_FORMAT[extname(absPath).toLowerCase()];
    const magic = await fileTypeFromFile(absPath).catch(() => undefined);
    if (magic !== undefined) {
        const byMagic = MAGIC_FORMAT[magic.ext];
        if (byMagic !== undefined) {
            return byMagic;
        }
        return magic.ext === "zip" && byExtension !== undefined && ZIP_CONTAINERS.has(byExtension) ? byExtension : undefined;
    }
    return byExtension;
};
