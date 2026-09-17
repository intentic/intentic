import { extname } from "node:path";
import { fileTypeFromFile } from "file-type";

// Which files fileq can turn into markdown, shared by the CLI (routes on it) and the daemon (its cheap pre-filter), so
// the two can never disagree about what's derivable.
// Recognition mirrors the daemon's workspace classifier: magic bytes first, extension as fallback for formats magic
// can't see (.html has no signature).
// Magic wins over a lying extension both ways: a renamed docx still derives, a fake .docx is refused rather than
// mis-parsed.

export type Format = "docx" | "xlsx" | "pptx" | "pdf" | "image" | "media" | "html" | "ipynb" | "odt" | "ods" | "odp" | "rtf" | "epub" | "archive";

// file-type's ext per container to its format; preferred over sniffing zip since it names OOXML/ODF/EPUB.
const MAGIC_FORMAT: Record<string, Format> = {
    docx: "docx",
    xlsx: "xlsx",
    pptx: "pptx",
    odt: "odt",
    ods: "ods",
    odp: "odp",
    rtf: "rtf",
    epub: "epub",
    pdf: "pdf",
    zip: "archive",
    jar: "archive",
    apk: "archive",
    tar: "archive",
    "tar.gz": "archive",
    gz: "archive",
    bz2: "archive",
    xz: "archive",
    zst: "archive",
    "7z": "archive",
    rar: "archive",
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
    ".ott": "odt", // a template is the same document with a different intent
    ".ods": "ods",
    ".ots": "ods",
    ".odp": "odp",
    ".otp": "odp",
    ".odg": "odp", // a drawing is a presentation of one page
    ".rtf": "rtf",
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
    // Archives, including the three zip-underneath package formats (a jar, a war and a wheel are each a zip with a
    // manifest); a double extension like `.tar.gz` is recognized by its last one, which is the compressor.
    ".zip": "archive",
    ".jar": "archive",
    ".war": "archive",
    ".whl": "archive",
    ".tar": "archive",
    ".tgz": "archive",
    ".gz": "archive",
    ".bz2": "archive",
    ".xz": "archive",
    ".zst": "archive",
    ".7z": "archive",
    ".rar": "archive",
};

/** Cheap pre-filter: could this path, by name alone, have a derivable format? Runs over every watcher batch. */
export const isCandidatePath = (path: string): boolean => extname(path).toLowerCase() in EXTENSION_FORMAT;

// Zip-underneath formats where magic can only say "zip"; the extension names the real container instead.
const ZIP_CONTAINERS: ReadonlySet<Format> = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp", "epub"]);

/** Magic bytes first, extension only when magic says nothing or just "zip" where the extension claims an OOXML container. */
export const detectFormat = async (absPath: string): Promise<Format | undefined> => {
    const byExtension = EXTENSION_FORMAT[extname(absPath).toLowerCase()];
    const magic = await fileTypeFromFile(absPath).catch(() => undefined);
    if (magic !== undefined) {
        // Checked before the magic table, where plain "zip" means an archive: a docx whose OOXML markers magic missed
        // is still a document, and only its extension can say so.
        return magic.ext === "zip" && byExtension !== undefined && ZIP_CONTAINERS.has(byExtension) ? byExtension : MAGIC_FORMAT[magic.ext];
    }
    return byExtension;
};

// Formats whose text diff is already the better reading: a textconv over them would replace a line diff with a
// rendering of the same text.
const TEXT_UNDERNEATH: ReadonlySet<Format> = new Set(["html"]);

/**
 * A gitattributes file naming every derivable extension as `diff=fileq`, so `git diff`, `git show` and `git log -p`
 * print fileq's text for a document instead of "Binary files differ" once `diff.fileq.textconv` is `fileq read --plain`.
 */
export const gitAttributeLines = (): string[] =>
    Object.entries(EXTENSION_FORMAT)
        .filter(([, format]) => !TEXT_UNDERNEATH.has(format))
        .map(([extension]) => `*${extension} diff=fileq`)
        .toSorted();
