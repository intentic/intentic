import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { realInside } from "@intentic/base/contained";
import { WEBEXT_MEDIA_MAX_BYTES } from "@intentic/sandbox-contract/protocol/doors/webext-links";
import { placeArtifact } from "../browser/cast/browser-artifacts.js";
import { stateRelPath } from "../state-paths.js";

// The artifacts shelf as the owner's own browser reaches it (the extension's `save_media` and `upload_file`):
// what a page hands the sandbox lands in `chrome/`, beside the sandbox browser's own captures in `browser/`, outside
// every repository; and what may go the other way is a file anywhere on that shelf (attachments included), never one
// from a repository, a secret or anything a link on the shelf points out to.

// Where a browser's saved media lands, relative to the workspace root.
export const CHROME_MEDIA_REL = stateRelPath(".intentic/records/artifacts/", "chrome");
// The only tree a file may leave for a website from, relative to the workspace root.
const SHELF_REL = stateRelPath(".intentic/records/artifacts/");

// What a file's bytes say it is, as the extension sniffed them, to the extension it is stored under. A type not listed
// is stored as `.bin` rather than refused: the agent asked for that file, and the name only has to be honest.
const EXTENSIONS = new Map<string, string>(Object.entries({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/bmp": "bmp",
    "image/x-icon": "ico",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/ogg": "ogv",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/flac": "flac",
    "audio/webm": "weba",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "text/plain": "txt",
    "text/csv": "csv",
    "application/json": "json",
}));

// The other way round, for a file leaving the shelf: what a page's file input is told it is.
const TYPES = new Map<string, string>([
    ...[...EXTENSIONS].map(([type, ext]) => [ext, type] as const),
    ["jpeg", "image/jpeg"],
    ["md", "text/markdown"],
    ["html", "text/html"],
]);

const mimeTypeOf = (fileName: string): string => TYPES.get(extname(fileName).slice(1).toLowerCase()) ?? "application/octet-stream";

// A page-suggested name made safe to be a file name and to be read back in a tool answer: letters, digits, dot, dash and
// underscore only, so nothing a page wrote survives as markup or a path. Empty becomes "media".
export const safeStem = (suggested: string): string => {
    const stem = suggested
        .normalize("NFKD")
        .replace(/\.[A-Za-z0-9]{1,5}$/u, "")
        .replace(/[^A-Za-z0-9._-]+/gu, "-")
        .replace(/-{2,}/gu, "-")
        .replace(/^[-.]+|[-.]+$/gu, "")
        .slice(0, 60);
    return stem === "" ? "media" : stem;
};

export interface StoredMedia {
    readonly path: string;
    readonly bytes: number;
    readonly mimeType: string;
}

// Writes one file onto the shelf under a name no earlier file holds (`frame-2.png` after `frame.png`), never in place
// of one: an earlier save is some transcript's file.
export const storeMedia = async (root: string, bytes: Uint8Array, mimeType: string, suggested: string): Promise<StoredMedia> => {
    const dir = join(root, CHROME_MEDIA_REL);
    await mkdir(dir, { recursive: true });
    const ext = EXTENSIONS.get(mimeType) ?? "bin";
    const target = await placeArtifact(dir, `${safeStem(suggested)}.${ext}`);
    // `wx`: a name taken between the look and the write fails here rather than overwriting.
    await writeFile(target, bytes, { flag: "wx" });
    return { path: target, bytes: bytes.byteLength, mimeType };
};

export interface ShelfFile {
    readonly path: string;
    readonly name: string;
    readonly bytes: number;
    readonly mimeType: string;
}

export type Releasable = ({ readonly ok: true } & ShelfFile) | { readonly ok: false; readonly refusal: string };

const SHELF_HINT = `Only files on the artifacts shelf (${SHELF_REL}/, chat attachments included) can be put into a page: copy the file there first.`;

// Whether `asked` (absolute, or relative to the workspace root) is a file that may go to a website: a regular file whose
// real path, every link followed, is on the shelf, and no larger than one file may be. Asked again when the file is
// collected, so a link swapped in between finds the same refusal.
export const releasable = async (root: string, asked: string): Promise<Releasable> => {
    const path = isAbsolute(asked) ? asked : join(root, asked);
    const real = await realInside(join(root, SHELF_REL), path);
    if (real === undefined) {
        return { ok: false, refusal: `${asked} is not on the artifacts shelf. ${SHELF_HINT}` };
    }
    // allow(silent-catch): a missing file is the refusal below
    const stat = await lstat(real).catch(() => undefined);
    if (stat === undefined) {
        return { ok: false, refusal: `There is no file at ${asked}.` };
    }
    if (!stat.isFile()) {
        return { ok: false, refusal: `${asked} is not a file.` };
    }
    if (stat.size === 0) {
        return { ok: false, refusal: `${asked} is empty.` };
    }
    if (stat.size > WEBEXT_MEDIA_MAX_BYTES) {
        return { ok: false, refusal: `${asked} is ${Math.round(stat.size / 1_048_576)} MB; a page takes at most ${WEBEXT_MEDIA_MAX_BYTES / 1_048_576} MB from the sandbox.` };
    }
    return { ok: true, path: real, name: basename(real), bytes: stat.size, mimeType: mimeTypeOf(real) };
};

export const readShelfFile = async (file: ShelfFile): Promise<Buffer> => await readFile(file.path);
