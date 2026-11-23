import { constants } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isInside } from "@intentic/base/contained";
import { type PageMediaFile, type PageMediaManifest, pageMediaSigned, readPageMedia } from "@intentic/sandbox-contract/text/pages";
import { keptKey } from "../../../auth/signed-payload.js";
import { loadOrMintKey } from "../../../store/plain-files/minted-key.js";
import { PAGES_DIR } from "./stored-pages.js";

// What makes a shown page's video and audio servable, kept below the agent as stored-pages.ts keeps pages: the key its
// manifest is signed under, the signature, the places a page may stream from, the formats it streams and the checks on
// a file before a byte of it is served. The agent records media as it shows a page (agent/pages/page-media.ts) and its
// route streams it (agent/pages/page-media.routes.ts); a runner serves a page's media to its parent, and the parent
// re-signs a copied page under its own key (runners/held-turns/runner-pages.ts), each from here.

// The key manifests are signed under, minted once and kept with the daemon's other keys, outside the agent's reach.
export const pageMediaKeyPath = (historyRoot: string): string => join(historyRoot, "page-media.key");

// Read once per key file and kept; a read that fails is asked again next time.
const keys = new Map<string, () => Promise<Buffer>>();
const keyAt = (path: string): Promise<Buffer> => {
    let key = keys.get(path);
    if (key === undefined) {
        key = keptKey(() => loadOrMintKey(path));
        keys.set(path, key);
    }
    return key();
};

// Prepended to what the signature reads, so nothing else ever signed under a daemon key could pass as a manifest.
const DOMAIN = "page-media:";

const signatureOf = async (keyPath: string, page: string, files: readonly PageMediaFile[]): Promise<string> =>
    createHmac("sha256", await keyAt(keyPath)).update(`${DOMAIN}${pageMediaSigned(page, files)}`).digest("base64url");

// The manifest for `files` on the page stored at `page` (its workspace path), signed.
export const signPageMedia = async (keyPath: string, page: string, files: readonly PageMediaFile[]): Promise<PageMediaManifest> => ({
    files,
    signature: await signatureOf(keyPath, page, files),
});

// The files a stored page's manifest names, only when the daemon signed that manifest for this very page; undefined for a
// page with none, or one whose manifest anyone else wrote, edited or copied in from another page.
export const verifiedPageMedia = async (keyPath: string, page: string, html: string): Promise<readonly PageMediaFile[] | undefined> => {
    const manifest = readPageMedia(html);
    if (manifest === undefined) {
        return undefined;
    }
    const expected = Buffer.from(await signatureOf(keyPath, page, manifest.files));
    const given = Buffer.from(manifest.signature);
    return expected.length === given.length && timingSafeEqual(expected, given) ? manifest.files : undefined;
};

// Where a stored page's media may be served from: the shared tree, and the checkout of the conversation that showed it,
// which its stored path names (pages/<conversation>/<page>.html, page-store.ts). A page path whose conversation folder is
// not one page-store could have written names no checkout.
export const pageMediaRoots = (workspaceRoot: string, historyRoot: string, page: string): string[] => {
    const folder = page.startsWith(PAGES_DIR) ? page.slice(PAGES_DIR.length).split("/")[0] : undefined;
    return folder === undefined || folder === "loose" || !/^[A-Za-z0-9_-]+$/.test(folder) ? [workspaceRoot] : [workspaceRoot, join(historyRoot, "worktrees", folder)];
};

// Video and audio a page may stream, by the name a browser plays them under. Kept to formats a browser decodes, so a file
// the reader could never play is named back to the agent now rather than drawn as a broken player.
export const STREAMED_MEDIA_TYPES = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    ogv: "video/ogg",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    flac: "audio/flac",
} as const satisfies Readonly<Record<string, string>>;
type StreamedExtension = keyof typeof STREAMED_MEDIA_TYPES;
export const isStreamedExtension = (extension: string): extension is StreamedExtension => Object.hasOwn(STREAMED_MEDIA_TYPES, extension);
export const STREAMED_EXTENSIONS = Object.keys(STREAMED_MEDIA_TYPES).join("|");

export const extensionOf = (path: string): string => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

// The type a file streams as, from its name alone; undefined for a name that is no format a page streams.
const streamedTypeOf = (path: string): string | undefined => {
    const extension = extensionOf(path);
    return isStreamedExtension(extension) ? STREAMED_MEDIA_TYPES[extension] : undefined;
};

// How many bytes of a media file say what it is.
const HEAD_BYTES = 16;

// Whether a media file's first bytes are what its name says, so a renamed file or a link cannot stream some other file
// to a reader under a video's name. Each container's own signature: an ISO box (`ftyp`, or a bare QuickTime atom), EBML,
// an Ogg page, RIFF/WAVE, FLAC, and an MP3's tag or frame sync.
const SIGNATURES = {
    mp4: (text) => text.slice(4, 8) === "ftyp",
    m4v: (text) => text.slice(4, 8) === "ftyp",
    m4a: (text) => text.slice(4, 8) === "ftyp",
    mov: (text) => ["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"].includes(text.slice(4, 8)),
    webm: (text) => text.startsWith("\x1a\x45\xdf\xa3"),
    ogv: (text) => text.startsWith("OggS"),
    ogg: (text) => text.startsWith("OggS"),
    oga: (text) => text.startsWith("OggS"),
    opus: (text) => text.startsWith("OggS"),
    wav: (text) => text.startsWith("RIFF") && text.slice(8, 12) === "WAVE",
    flac: (text) => text.startsWith("fLaC"),
    mp3: (text, head) => text.startsWith("ID3") || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0),
} as const satisfies Readonly<Record<StreamedExtension, (text: string, head: Uint8Array) => boolean>>;

const readHead = async (handle: FileHandle): Promise<Uint8Array> => {
    const head = new Uint8Array(HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
    return head.subarray(0, bytesRead);
};

// The file's first bytes: read from `handle` when the caller already holds the file open (and will stream from it), else
// from a handle of its own; undefined when it cannot be read.
const headOf = async (path: string, handle?: FileHandle): Promise<Uint8Array | undefined> => {
    if (handle !== undefined) {
        return readHead(handle);
    }
    // allow(silent-catch): a file that cannot be opened is refused by the caller, which says why.
    const own = await open(path, "r").catch(() => undefined);
    if (own === undefined) {
        return undefined;
    }
    try {
        return await readHead(own);
    } finally {
        await own.close();
    }
};

// Whether the file at `path` (already resolved) holds the format its name says; asked of `handle` where the caller holds
// the file open, so the answer is about the very bytes it goes on to read.
export const holdsStreamedMedia = async (path: string, handle?: FileHandle): Promise<boolean> => {
    const extension = extensionOf(path);
    if (!isStreamedExtension(extension)) {
        return false;
    }
    const head = await headOf(path, handle);
    return head !== undefined && SIGNATURES[extension](String.fromCharCode(...head), head);
};

// The recorded file, opened, or why it is not served now. Asked again on every request, not trusted from the manifest
// alone: a manifest is text in the records, and the file it names may have been moved, linked elsewhere or rewritten
// since. Everything after the open is asked of the open file itself, and the bytes are streamed from that same handle:
// a name swapped for a link between a check and the read (a race an agent can run in its own checkout) would otherwise
// stream whatever the link leads to under the size and type of the take that passed.
export type Refusal = { readonly status: 404 | 409 | 415; readonly message: string };
export type Opened = { readonly handle: FileHandle; readonly type: string } | Refusal;
// The one answer for a file that is not served, whatever the reason short of a change to the very file the page showed.
export const NOT_SERVED = {
    status: 404,
    message: "This page has no such video or audio to play: the agent may have moved or removed it after showing the page.",
} as const satisfies Refusal;
export const openRecorded = async (file: PageMediaFile, roots: readonly string[]): Promise<Opened> => {
    const inside = (path: string): boolean => roots.some((root) => isInside(root, path));
    // Asked of the recorded path before anything is asked of the disk, so a path outside is never looked at.
    if (!inside(file.path)) {
        return NOT_SERVED;
    }
    // allow(silent-catch): a file that cannot be resolved is not served, in the one answer every such file gets.
    const real = await realpath(file.path).catch(() => undefined);
    // Served as the type its name says, never the manifest's word for it.
    const type = real === undefined ? undefined : streamedTypeOf(real);
    if (real === undefined || real !== file.path || type === undefined || !inside(real)) {
        return NOT_SERVED;
    }
    // Without following a link, and without waiting: a pipe named like a take would otherwise hold the open, and a thread of
    // the daemon's file I/O with it, until something wrote to it. Neither changes how a regular file reads.
    // allow(silent-catch): a file that cannot be opened (gone, or its last part now a link) is answered as gone.
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
    if (handle === undefined) {
        return NOT_SERVED;
    }
    let refused: Awaited<ReturnType<typeof refusalOf>> | "unasked" = "unasked";
    try {
        refused = await refusalOf(handle, file);
    } finally {
        if (refused !== undefined) {
            await handle.close();
        }
    }
    return refused === undefined ? { handle, type } : refused;
};

// Why the open file is not the one recorded, or undefined when it is: unchanged since the page was shown (its size and
// modification time, which only its writer sets) and still holding the format its name says.
const refusalOf = async (handle: FileHandle, file: PageMediaFile): Promise<Refusal | undefined> => {
    const info = await handle.stat();
    if (!info.isFile()) {
        return NOT_SERVED;
    }
    if (info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
        return { status: 409, message: "This file changed after the page was shown, so it no longer plays here: ask the agent to show the new version." };
    }
    return (await holdsStreamedMedia(file.path, handle)) ? undefined : { status: 415, message: "This file is not the video or audio its name says." };
};
