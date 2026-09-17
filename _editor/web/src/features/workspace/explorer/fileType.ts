import { HIGHLIGHT_MAX_BYTES, langFor, nameExt } from "@intentic/code-read";
import type { ShikiLang } from "@intentic/code-read/langs";

// Classifies a path as text (source, prose, opaque) and its Shiki grammar, read also by chat Read cards and search
// rows. Every other format (picture, PDF, spreadsheet, recording) belongs to a viewers extension: unclaimed, it falls
// back to bytes and a download. Pure, no framework code.

// `big-text` isn't resolved here: over the edit cap, text renders windowed and read-only (BigTextView), decided once
// the daemon reports a size, like `binary` for an unknown extension whose bytes hold NUL.
export type TextMode = "code" | "markdown" | "binary" | "empty";

export interface FileResolution {
    readonly mode: TextMode;
    // Shiki language id; undefined means plaintext, the only value `binary`/`empty` ever carry.
    readonly lang?: ShikiLang;
}

// Matches the daemon's MAX_RAW_BYTES; /workspace/raw 413s above it. Fetch kind decides the cap, not file type.
export const RAW_MAX_BYTES = 25 * 1024 * 1024;
// Above this, text opens windowed and read-only (BigTextView), not editable: not a refusal, a serving limit.
export const TEXT_EDIT_MAX_BYTES = 2_000_000;

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

// A document rather than code: what a diff can show as tracked changes (viewers/ProseDiffView.vue). Plain text counts,
// since a maker's notes are as often .txt as .md.
export const isProsePath = (path: string): boolean => {
    const { ext } = nameExt(path);
    return MARKDOWN_EXTS.has(ext) || ext === "txt";
};

// A file whose diff can read as tracked changes over the text fileq renders from it (viewers/DerivedDiffView.vue):
// documents, spreadsheets, decks, books, notebooks and archives. Pictures and recordings are not: their two sides are
// looked at, not read. A notebook is text by every other rule here and unreadable as JSON, so it is in.
const DOCUMENT_EXTS = new Set([
    "docx",
    "odt",
    "ott",
    "rtf",
    "epub",
    "pdf",
    "pptx",
    "odp",
    "otp",
    "odg",
    "xlsx",
    "ods",
    "ots",
    "ipynb",
    "zip",
    "jar",
    "war",
    "whl",
    "tar",
    "tgz",
    "gz",
    "bz2",
    "xz",
    "zst",
    "7z",
    "rar",
]);
export const isDocumentPath = (path: string): boolean => DOCUMENT_EXTS.has(nameExt(path).ext);

// A document whose rendered text is one table per sheet, so its diff is a grid of cells, not paragraphs
// (viewers/TableDiffView.vue).
const SPREADSHEET_EXTS = new Set(["xlsx", "ods", "ots"]);
export const isSpreadsheetPath = (path: string): boolean => SPREADSHEET_EXTS.has(nameExt(path).ext);

// Text that is a table: read as rows and cells by the same grid diff, with the line diff as its other reading.
const DELIMITED_EXTS = new Set(["csv", "tsv"]);
export const isDelimitedPath = (path: string): boolean => DELIMITED_EXTS.has(nameExt(path).ext);

// Never read as text; also covers viewer-extension formats. SVG stays out: it's text (XML), not binary.
const BINARY_EXTS = new Set([
    "woff",
    "woff2",
    "ttf",
    "otf",
    "eot", // fonts
    "zip",
    "gz",
    "tgz",
    "tar",
    "rar",
    "7z",
    "bz2",
    "xz",
    "zst",
    "jar",
    "war",
    "whl", // archives, the packaged-as-a-zip ones included
    "exe",
    "dll",
    "so",
    "dylib",
    "bin",
    "dat",
    "o",
    "a",
    "obj",
    "wasm",
    "node", // binaries
    "class",
    "pyc",
    "lockb", // compiled/lock
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "avif",
    "bmp",
    "ico", // pictures a browser can paint (`image` viewer)
    "heic",
    "heif",
    "tiff",
    "psd",
    "sketch",
    "fig", // pictures no viewer claims; stay downloads
    "pdf",
    "docx",
    "xlsx",
    "pptx",
    "odt",
    "ott",
    "ods",
    "ots",
    "odp",
    "otp",
    "odg",
    "otg",
    "rtf",
    "epub", // documents (the `pdf`, `docx`, `xlsx`, `pptx`, `odf-*`, `rtf` and `epub` viewers)
    "mp3",
    "wav",
    "flac",
    "ogg",
    "oga",
    "opus",
    "weba",
    "m4a",
    "aac", // audio
    "mp4",
    "m4v",
    "webm",
    "ogv",
    "mov",
    "3gp",
    "mkv",
    "avi",
    "wmv", // video (with audio, the `media` viewer)
]);


// Resolves how to render `path` from its byte size (undefined if unknown or unstat-able); resolves optimistically,
// letting a post-read NUL check or daemon 413 catch the rare bad case.
export const resolveFile = (path: string, size: number | undefined): FileResolution => {
    const { name, ext } = nameExt(path);
    // Tokenizer hint for both text modes, resolved once so every surface agrees; nothing above the highlight cap.
    const lang = size !== undefined && size > HIGHLIGHT_MAX_BYTES ? undefined : langFor(name, ext);

    if (MARKDOWN_EXTS.has(ext)) {
        return { mode: "markdown", lang };
    }
    if (BINARY_EXTS.has(ext)) {
        // Empty binary short-circuits to `empty` before any viewer; empty text still opens as a blank editable buffer.
        return size === 0 ? { mode: "empty" } : { mode: "binary" };
    }
    // Falls through to text, unknown extensions included; no size gate, FileViewer decides from the daemon's size.
    return { mode: "code", lang };
};

// Modes a line diff suits; `empty` is unreachable here (no size passed), leaving only `binary` otherwise.
const TEXT_MODES: ReadonlySet<TextMode> = new Set<TextMode>(["code", "markdown"]);

// True when the daemon flags `binary` (NUL bytes, unhelpful extension) or the path itself never held text (.png, .pdf,
// .zip); the path check also catches an oversized image the daemon never even opens.
export const rendersAsBytes = (path: string, binary: boolean | undefined): boolean =>
    binary === true || !TEXT_MODES.has(resolveFile(path, undefined).mode);
