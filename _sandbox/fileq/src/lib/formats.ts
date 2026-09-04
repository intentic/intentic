import { extname } from "node:path";
import { fileTypeFromFile } from "file-type";

/* WHICH FILES FILEQ CAN TURN INTO MARKDOWN, and how one is recognized. This table is the package's public
 * face twice over: the CLI routes on it, and the daemon imports it (`@intentic/fileq/formats`) to decide
 * which watcher paths are worth a fileq spawn at all — one source, so the daemon's cheap pre-filter and the
 * CLI's real routing can never disagree about what is derivable.
 *
 * Recognition mirrors the daemon's workspace classifier (sandbox/src/workspace/classify.ts): magic bytes
 * first, extension as the fallback for the text-based formats magic is blind to (.html has no signature).
 * Magic wins over a lying extension in BOTH directions — a docx renamed .zip still derives, and a .docx that
 * is really something else is refused rather than fed to a parser that will produce nonsense. */

export type Format = "docx" | "xlsx" | "pptx" | "pdf" | "image" | "media" | "html" | "ipynb" | "odt" | "epub";

/* file-type's `ext` for every container we handle → the deriver that handles it. file-type resolves OOXML
 * and OpenDocument containers and EPUBs to their own ext (docx/odt/epub, not zip), which is the whole reason
 * to prefer it over sniffing application/zip ourselves. */
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

// Extension → format, for files magic cannot identify (html) and as the pre-filter the sweep and the daemon
// run before paying for a magic read. Keys are lowercase extnames WITH the dot, the shape extname() returns.
export const EXTENSION_FORMAT: Record<string, Format> = {
    ".docx": "docx",
    ".xlsx": "xlsx",
    ".pptx": "pptx",
    ".odt": "odt",
    ".epub": "epub",
    ".ipynb": "ipynb", // JSON: no magic bytes can name it, so the extension is the whole recognition
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

/** The cheap pre-filter: could this path, by name alone, have a derivable format? The daemon runs this over
 * every watcher batch so an ordinary code edit never costs a fileq spawn. */
export const isCandidatePath = (path: string): boolean => extname(path).toLowerCase() in EXTENSION_FORMAT;

// The zip-underneath formats (OOXML, OpenDocument, EPUB): the one place a plain-container magic verdict
// defers to the extension, because generators exist whose output file-type can only call "zip" (an
// OpenDocument whose `mimetype` entry is not first, an EPUB packed by a plain zip tool) while the extension
// names which container it is. The deriver then fails loudly on a lie instead of this table guessing silently.
const ZIP_CONTAINERS: ReadonlySet<Format> = new Set(["docx", "xlsx", "pptx", "odt", "epub"]);

/** What a file actually is: magic bytes first, extension only when the bytes say nothing (or say only "some
 * zip" where the extension claims an OOXML container). A file whose magic names a format we do not derive
 * (a .html that is really a png) answers undefined rather than falling back — the extension was lying, and a
 * parser fed the lie produces garbage with a confident face. */
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
