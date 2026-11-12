import { createHmac, timingSafeEqual } from "node:crypto";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isInside } from "@intentic/base/contained";
import { undefinedIfMissing } from "@intentic/base/errors";
import { PAGE_MEDIA_MAX, PAGE_MEDIA_REF, type PageMediaFile, type PageMediaManifest, pageMediaSigned, readPageMedia } from "@intentic/sandbox-contract/text/pages";
import { keptKey } from "../../auth/signed-payload.js";
import { loadOrMintKey } from "../../store/plain-files/minted-key.js";
import { PAGES_DIR } from "./pages-dir.js";

// Video and audio a shown page plays from disk. A take is tens of megabytes, far past what a page can carry inside itself
// the way it carries pictures (page-assets.ts), so when the page is shown each file it names is recorded instead: its real
// path, type, size and modification time, in a manifest the stored page keeps (sandbox-contract text/pages.ts), and the
// reference in the page becomes `intentic-media:<n>`. The reader's chat mints a ticket for that one page and streams
// each file from GET /pages/media/{ticket}/{n} in byte ranges (page-media.routes.ts), so a player seeks at full quality
// without a byte of the file passing through the page.
//
// A file is served only while it is still the one that was shown: same real path, size and modification time, its bytes
// still the format its name says. A page is a record of what the reader saw beside what the agent said about it, and a
// take re-rendered under the same name would quietly turn "take 2 flickers" into a sentence about another video; the
// overwritten file is refused instead, and the agent shows a new page for the new take.
//
// Media is named only from the workspace and the showing turn's own checkout, never /tmp: under the turn's jail its /tmp
// is its own, so the daemon's /tmp is not where the agent rendered anything. And the manifest is signed: it is text in
// the records, which an agent or anyone who writes the workspace can edit, so only one the daemon wrote for that very page
// is ever served.

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
const STREAMED_MEDIA_TYPES = {
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
const isStreamedExtension = (extension: string): extension is StreamedExtension => Object.hasOwn(STREAMED_MEDIA_TYPES, extension);
export const STREAMED_EXTENSIONS = Object.keys(STREAMED_MEDIA_TYPES).join("|");

const extensionOf = (path: string): string => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

// The type a file streams as, from its name alone; undefined for a name that is no format a page streams.
export const streamedTypeOf = (path: string): string | undefined => {
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

export interface MediaTally {
    // The files recorded to stream, in the order their references number them.
    readonly media: readonly PageMediaFile[];
    // The same files as the page named them, in that order, for telling the agent.
    readonly mediaNamed: readonly string[];
    // Video and audio the page names that will not play, each with why.
    readonly mediaRefused: readonly { readonly ref: string; readonly reason: string }[];
}

// One page's media as it is carried: each file checked and recorded once however often the page names it, numbered in
// the order first named. `roots` are the folders a page may name media from: the workspace and the turn's own checkout.
export const mediaRecorder = (roots: readonly string[]) => {
    const recorded = new Map<string, { readonly index: number; readonly file: PageMediaFile; readonly named: string }>();
    const refused = new Map<string, string>();

    const refuse = (named: string, reason: string): undefined => {
        refused.set(named, reason);
        return undefined;
    };

    // The reference the page holds in place of `file` (as the page named it, `named`), or undefined, the reason kept.
    const recordNow = async (file: string, named: string): Promise<string | undefined> => {
        const extension = extensionOf(file);
        if (!isStreamedExtension(extension)) {
            return refuse(named, `not a video or audio format a browser plays (${Object.keys(STREAMED_MEDIA_TYPES).join(", ")})`);
        }
        // allow(silent-catch): a file that cannot be resolved is refused, with the reason the agent can act on.
        const real = await realpath(file).catch(() => undefined);
        if (real === undefined) {
            return refuse(named, "no such file");
        }
        if (!roots.some((root) => isInside(root, real))) {
            return refuse(named, "outside the workspace and your own checkout, the only places a page streams video and audio from");
        }
        const known = recorded.get(real);
        if (known !== undefined) {
            return `${PAGE_MEDIA_REF}${known.index}`;
        }
        const info = await stat(real).catch(undefinedIfMissing);
        if (info === undefined || !info.isFile()) {
            return refuse(named, "not a file");
        }
        if (!(await holdsStreamedMedia(real))) {
            return refuse(named, `its bytes are not ${extension.toUpperCase()}, whatever its name says`);
        }
        if (recorded.size >= PAGE_MEDIA_MAX) {
            return refuse(named, `a page streams at most ${PAGE_MEDIA_MAX} video and audio files`);
        }
        const index = recorded.size;
        recorded.set(real, { index, file: { path: real, type: STREAMED_MEDIA_TYPES[extension], size: info.size, mtimeMs: info.mtimeMs }, named });
        return `${PAGE_MEDIA_REF}${index}`;
    };

    // One at a time, in the order the page names them: carrying asks for every reference at once, and numbering in the
    // order their checks happened to finish made a page's first take index 1 on one showing and 0 on the next.
    let queue: Promise<unknown> = Promise.resolve();
    const record = (file: string, named: string): Promise<string | undefined> => {
        const next = queue.then(() => recordNow(file, named));
        // allow(silent-catch): the failure is the caller's, through `next`; the queue only waits for it to settle.
        queue = next.catch(() => undefined);
        return next;
    };

    const tally = (): MediaTally => {
        const ordered = [...recorded.values()].toSorted((a, b) => a.index - b.index);
        return {
            media: ordered.map((entry) => entry.file),
            mediaNamed: ordered.map((entry) => entry.named),
            mediaRefused: [...refused].map(([ref, reason]) => ({ ref, reason })),
        };
    };

    return { record, tally };
};
