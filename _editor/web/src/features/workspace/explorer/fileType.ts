import { HIGHLIGHT_MAX_BYTES, langFor, nameExt } from "@intentic/code-read";
import type { ShikiLang } from "@intentic/code-read/langs";

/* THE CORE'S ANSWER TO "WHAT IS THIS FILE?", and deliberately a small one.
 *
 * This module knows about TEXT: is a path source, prose, or opaque bytes, and which Shiki grammar colours it.
 * That is the app's own business, the workspace editor is Monaco plus the edit buffers plus the guarded save,
 * and its language table is read by the chat's Read cards and the search rows too, none of which are viewers.
 *
 * Every OTHER format, a picture, a PDF, a spreadsheet, a recording, is a viewers EXTENSION's business, and
 * this file has no branch for any of them. They land in BINARY_EXTS, meaning "the core has nothing to show
 * for this"; the extension registry then overrides that per open file (see viewers/openFile.ts). Switch the
 * extension off and the honest fallback is exactly what this module already says: bytes, and a download.
 *
 * Pure, and no framework code, unit-testable in isolation. */

// `big-text` is not resolvable here: text over the editable cap renders windowed and read-only (BigTextView)
// instead of as a buffer, and that decision needs the size the daemon reports with the first window. Like
// `binary`, which an unknown-extension file only earns once its bytes turn out to hold NUL.
export type TextMode = "code" | "markdown" | "binary" | "empty";

export interface FileResolution {
    readonly mode: TextMode;
    // Shiki language id, carried by both TEXT modes (`code`, `markdown`), prose renders through the same editor
    // under its Source toggle, so both need a grammar. undefined opens as plaintext (unknown extension, or a file
    // too big to tokenize) and is the only value `binary`/`empty` ever carry.
    readonly lang?: ShikiLang;
}

/* Size gates (bytes). Tuned for a browser relay, not VSCode's multi-GB limits.
 *
 * RAW_MAX_BYTES matches the daemon's MAX_RAW_BYTES: /workspace/raw holds the whole answer in memory and 413s
 * above it, so a viewer fed by that route (a picture, a PDF, a .docx) pre-empts the refusal instead of letting
 * it arrive as a broken render. Nothing in THIS module gates on it any more, the cap belongs to the fetch
 * kind, not the file type, and only viewers/openFile.ts knows which kind an open file will use. A `url` viewer
 * streams byte ranges off /workspace/media and has no ceiling at all. */
export const RAW_MAX_BYTES = 25 * 1024 * 1024;
/* Above this a text file opens READ-ONLY and WINDOWED (BigTextView) instead of as an editable buffer: the
 * editor holds the whole text plus a baseline to diff it against, and a save posts all of it back, none of
 * which a log wants. It is not a refusal, text always opens. Monaco itself is comfortable far above this
 * (a 120MB, 1M-line model builds in ~150ms); the ceiling is what the daemon will serve in one window. */
export const TEXT_EDIT_MAX_BYTES = 2_000_000;

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

/* Extensions the core will never try to read as text, the "no preview, here are the bytes" fallback.
 *
 * This list is longer than it used to be because it now also holds the formats a VIEWERS EXTENSION renders:
 * pictures, PDFs, Office documents, audio and video. That is the point, not an omission. The core's answer for
 * a .png is honestly "opaque bytes"; the picture is drawn by an extension that claims the extension at runtime
 * and overrides this (viewers/openFile.ts). Listing them here is what makes switching that extension off
 * degrade to a download instead of to a screenful of mojibake, and what keeps a diff of one showing as bytes
 * (rendersAsBytes) whether or not any extension happens to be loaded.
 *
 * SVG is NOT here, and never should be: it is XML, it diffs by line, and with no viewers extension loaded the
 * right fallback is its markup in the editor, not a download. */
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
    "xz", // archives
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
    "jar",
    "pyc",
    "lockb", // compiled/lock
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "avif",
    "bmp",
    "ico", // pictures a browser can paint: the viewers extension's `image`
    "heic",
    "heif",
    "tiff",
    "psd",
    "sketch",
    "fig", // pictures it cannot: no viewer claims these, so they stay downloads
    "pdf",
    "docx",
    "xlsx", // documents: the viewers extension's `pdf` / `docx` / `xlsx`
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
    "wmv", // video: both together are the viewers extension's `media`
]);


// Resolve how to render `path` given its byte size (undefined when unknown, the tree cap, or stat failed; we
// then proceed optimistically and let the post-read NUL check / daemon 413 catch the rare bad case).
export const resolveFile = (path: string, size: number | undefined): FileResolution => {
    const { name, ext } = nameExt(path);
    // The tokenizer hint both TEXT modes carry. Resolved ONCE here rather than per-branch: markdown renders its
    // source through the same editor `code` does, so "what grammar is this file?" has exactly one answer per
    // path, independent of which surface shows it. Nothing at all above the highlight cap.
    const lang = size !== undefined && size > HIGHLIGHT_MAX_BYTES ? undefined : langFor(name, ext);

    if (MARKDOWN_EXTS.has(ext)) {
        return { mode: "markdown", lang };
    }
    if (BINARY_EXTS.has(ext)) {
        // Nothing to download and nothing for a viewer to render: an empty file of any binary format is a
        // statement about the file, not about the format, so it short-circuits before any of them. Text types
        // do NOT, an empty .ts opens as the blank editable buffer it should be.
        return size === 0 ? { mode: "empty" } : { mode: "binary" };
    }
    // Code or plain text, including unknown extensions and dotfiles, optimistically treated as text. No size
    // gate here: the SIZE the gate needs is the daemon's, which arrives with the first window (FileViewer), and
    // a resolution made from a tree entry that may be missing is exactly how an unbounded read used to slip
    // through. Text always resolves to text; how much of it opens, and whether it is editable, is decided there.
    return { mode: "code", lang };
};

// The render modes that are TEXT, the ones a line-by-line diff is the right tool for. (`empty` is unreachable
// below, which passes no size; the only other mode is `binary`, and bytes is exactly what it means.)
const TEXT_MODES: ReadonlySet<TextMode> = new Set<TextMode>(["code", "markdown"]);

// Is a DIFF of this path one to show as bytes rather than as text? Two independent answers, and both are
// needed:
//   - the daemon read NUL bytes out of a file whose extension told us nothing (`binary` on the response), or
//   - the path itself says there was never any text here, a .png, a .pdf, a .zip.
// The second is what keeps an image out of the oversized-text path. The daemon sizes a side BEFORE it ever
// looks for NUL bytes, so over its 512 KiB text cap it never reads the bytes at all, and a megabyte screenshot
// arrives described as a big file rather than as a picture. (Git's own "Binary files differ" verdict on the
// patch it computes instead does usually catch it — but only when a patch could be computed at all, and this
// answer is free.) /diff/raw serves it to 25 MiB, the size that matters for showing a picture, not the size
// that matters for tokenizing source.
export const rendersAsBytes = (path: string, binary: boolean | undefined): boolean =>
    binary === true || !TEXT_MODES.has(resolveFile(path, undefined).mode);
