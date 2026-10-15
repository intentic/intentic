import { extname } from "node:path";
import { fileTypeFromFile } from "file-type";

// Which files fileq can turn into markdown, shared by the CLI (routes on it) and the daemon (its cheap pre-filter), so
// the two can never disagree about what's derivable.
// Recognition mirrors the daemon's workspace classifier: magic bytes first, extension as fallback for formats magic
// can't see (.html has no signature).
// Magic wins over a lying extension both ways: a renamed docx still derives, a fake .docx is refused rather than
// mis-parsed.

export type Format = "docx" | "xlsx" | "pptx" | "pdf" | "image" | "media" | "html" | "ipynb" | "odt" | "ods" | "odp" | "rtf" | "epub" | "archive" | "profile";

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
    ".cpuprofile": "profile", // V8 profiles are JSON too: named by extension alone, like a notebook.
    ".heapprofile": "profile",
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

/**
 * detectFormat, then the extension when magic names something fileq does not read: a password-protected docx is an
 * encrypted container, not a zip, and a command that checks or draws documents still owes it its format's answer.
 */
export const claimedFormat = async (absPath: string): Promise<Format | undefined> => (await detectFormat(absPath)) ?? EXTENSION_FORMAT[extname(absPath).toLowerCase()];

// Documents: formats whose text is what a reader searches for, and cheap to derive (no model is asked anything, unless a
// scanned pdf finds the OCR pack). The daemon's shadow keeper keeps a shadow of every one of these in the workspace, and
// ripgrep reads them through fileq's preprocessor; pictures, recordings, archives and notebooks are left to be read
// when someone asks.
export const DOCUMENT_FORMATS: ReadonlySet<Format> = new Set(["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "epub"]);

/** Every extension (lower case, with its dot) a document format is recognised by. */
export const documentExtensions = (): string[] =>
    Object.entries(EXTENSION_FORMAT)
        .filter(([, format]) => DOCUMENT_FORMATS.has(format))
        .map(([extension]) => extension)
        .toSorted();

/** The format a path's extension names when it is a document; undefined for anything else. */
export const documentFormatOf = (path: string): Format | undefined => {
    const format = EXTENSION_FORMAT[extname(path).toLowerCase()];
    return format !== undefined && DOCUMENT_FORMATS.has(format) ? format : undefined;
};

// Both spellings of each extension, since ripgrep's globs are case-sensitive and a scanner names files `SCAN.PDF`.
const caseGlob = (extension: string): string => `*.{${extension.slice(1)},${extension.slice(1).toUpperCase()}}`;

/**
 * A ripgrep config (RIPGREP_CONFIG_PATH) routing every document through `pre`, fileq's preprocessor: one flag per
 * line, as ripgrep reads it. Code and every other file are untouched, since only these globs reach the preprocessor.
 */
export const ripgrepConfigLines = (pre: string): string[] => [
    "# fileq: ripgrep searches the text of documents, cited by page (`[p. 12] `); see `fileq ripgrep-config --help`.",
    `--pre=${pre}`,
    ...documentExtensions().map((extension) => `--pre-glob=${caseGlob(extension)}`),
];

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
