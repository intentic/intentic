import { STATE_DIR } from "@intentic/constants";
import { PICTURE_EDGES, type PictureEdge, type WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { ref } from "vue";
import { lazyByPath } from "../../../client/sandbox/lazyByPath";
import { sandboxBlob } from "../../../client/sandbox/sandboxClient";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { mediaUrl } from "../files/mediaUrl";
import { workspaceAgent } from "../../../app/workspaceScope";
import { quickLookPlan } from "./quickLookContent";

// A workspace file at the size it is drawn: a daemon rendition (`tile`, `gallery`, `strip`, `view`) or its own bytes
// (`original`).

export type PictureSize = "tile" | "gallery" | "strip" | "view" | "original" | `e${PictureEdge}`;

// `url` undefined is the daemon's final answer that nothing can be drawn there; the whole Picture undefined is still on its way.
export interface Picture {
    readonly url: string | undefined;
}

// Final answers: bad path, no access, gone, checkout cleaned up, too big; anything else is lazyByPath's to retry.
const NOTHING_THERE = new Set([400, 403, 404, 412, 413]);

// The daemon's word for a picture it will not re-encode (SVG, whose markup it won't rasterise).
const NOT_RENDERED = new Set([415]);

// A 1×1 AVIF, decoded once to learn whether this engine draws AVIF; the answer rides every view's Accept.
const AVIF_PROBE =
    "data:image/avif;base64,AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACAAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAobWRhdBIACgc4AAaQENBpMhMZQmMEw88880EgAJBBGex24O9g";

let avifProbe: Promise<boolean> | undefined;

// An engine without `decode` (jsdom) cannot say, and is sent WebP, which every engine draws.
const decodesAvif = (): Promise<boolean> => {
    avifProbe ??= (async () => {
        const probe = new Image();
        probe.src = AVIF_PROBE;
        return typeof probe.decode === `function`
            ? probe.decode().then(
                  () => probe.naturalWidth > 0,
                  () => false,
              )
            : false;
    })();
    return avifProbe;
};

const queryOf = (scope: string | undefined, path: string, size?: PictureSize): string => {
    const query = new URLSearchParams({ path });
    // The sandbox's own state is one directory every checkout shares, so a picture in it is read unscoped.
    if (scope !== undefined && !path.startsWith(`${STATE_DIR}/`)) {
        query.set(`agent`, scope);
    }
    if (size !== undefined) {
        query.set(`size`, size);
    }
    return query.toString();
};

const refusedWith = (error: unknown, statuses: ReadonlySet<number>): boolean => error instanceof SandboxHttpError && statuses.has(error.status);

// One route's answer, or undefined for a final refusal; any other failure propagates for lazyByPath.
const blobOf = async (route: string, accept?: string): Promise<Blob | undefined> => {
    try {
        return await sandboxBlob(route, accept === undefined ? undefined : { headers: { accept } });
    } catch (error) {
        if (refusedWith(error, NOTHING_THERE)) {
            return undefined;
        }
        throw error;
    }
};

// The sizes the daemon may answer in AVIF (its own table says which do): the viewer's, and the edges a large box asks for.
const mayBeAvif = (size: PictureSize): boolean => size === `view` || size.startsWith(`e`);

// What the daemon will not re-encode is drawn from the file, which for SVG is small anyway.
const pictureBlob = async (scope: string | undefined, path: string, size: PictureSize): Promise<Blob | undefined> => {
    if (size === `original`) {
        return blobOf(`/workspace/raw?${queryOf(scope, path)}`);
    }
    const accept = mayBeAvif(size) && (await decodesAvif()) ? `image/avif,image/webp` : `image/webp`;
    try {
        return await blobOf(`/workspace/thumb?${queryOf(scope, path, size)}`, accept);
    } catch (error) {
        if (refusedWith(error, NOT_RENDERED)) {
            return blobOf(`/workspace/raw?${queryOf(scope, path)}`);
        }
        throw error;
    }
};

const pictureUrl = async (scope: string | undefined, path: string, size: PictureSize): Promise<string | undefined> => {
    const blob = await pictureBlob(scope, path, size);
    return blob === undefined ? undefined : URL.createObjectURL(blob);
};

// A daemon rendition's bytes, for reading its pixels rather than drawing it (shotLooks.ts). WebP, which every engine
// decodes; a refusal throws as SandboxHttpError for the caller to judge.
export const renditionBlob = (scope: string | undefined, path: string, size: Exclude<PictureSize, "original">): Promise<Blob> =>
    sandboxBlob(`/workspace/thumb?${queryOf(scope, path, size)}`, { headers: { accept: `image/webp` } });

// One entry per size, scope and path: the same path names a different file in a conversation's own checkout.
const keyOf = (scope: string | undefined, path: string, size: PictureSize): string =>
    JSON.stringify([size, path.startsWith(`${STATE_DIR}/`) ? undefined : scope, path]);

const pictures = lazyByPath(async (key: string): Promise<Picture> => {
    const [size, scope, path] = JSON.parse(key) as [PictureSize, string | null, string];
    return { url: await pictureUrl(scope ?? undefined, path, size) };
});

// The picture at `size`, starting its fetch on first ask.
export const picture = (scope: string | undefined, path: string, size: PictureSize): Picture | undefined => pictures.get(keyOf(scope, path, size));

/**
 * A document's picture as markdownImages.ts draws it: its address once its bytes are here, `null` when the file has none
 * to give (gone, or refused), and undefined while they are still on their way, which the document draws as a placeholder.
 */
export const documentPicture = (scope: string | undefined, path: string): string | null | undefined => {
    const held = picture(scope, path, `original`);
    return held === undefined ? undefined : (held.url ?? null);
};

// Bytes this window already holds for a file it is uploading, so the original is never asked of the daemon.
export const rememberOriginal = (path: string, url: string): void => pictures.put(keyOf(undefined, path, `original`), { url });

// Forgets a remembered original whose object URL was just revoked, so nothing hands out a dead URL.
export const forgetOriginal = (path: string): void => pictures.drop(keyOf(undefined, path, `original`));

// How long a download's object URL outlives the click that started it, in milliseconds.
const DOWNLOAD_HOLD_MS = 10_000;

// Saves the original under its own name, read now rather than held: a download is one use, not something to cache.
export const downloadOriginal = async (scope: string | undefined, path: string): Promise<void> => {
    const url = await pictureUrl(scope, path, `original`);
    if (url === undefined) {
        return;
    }
    const link = document.createElement(`a`);
    link.href = url;
    link.download = path.split(`/`).at(-1) ?? path;
    link.click();
    // Held past the click: a browser that starts the download a beat later would otherwise find the bytes gone.
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_HOLD_MS);
};

// The home's tiles and quick look, promised and bounded: a folder of screenshots scrolled through must not hold them all.

export type ThumbnailKind = "picture" | "video";

export const thumbnailKind = (entry: WorkspaceTreeEntry): ThumbnailKind | undefined => {
    const { kind } = quickLookPlan(entry);
    return kind === `picture` || kind === `video` ? kind : undefined;
};

// --- Which size to ask for: the srcset a browser would pick from, picked here --------------------------------------
// The daemon answers a picture at a handful of long edges (PICTURE_EDGES), and a tile asks for the smallest one at
// least as long as the box it fills, in device pixels. It cannot hand the browser a srcset to pick from itself: the
// renditions are read with the sandbox's bearer, which an <img> cannot send, so they arrive as object URLs.

/** A long edge a tile can be drawn from: the grid tile's own rendition, or one of the daemon's edges. */
export type TileEdge = 256 | PictureEdge;
const TILE_EDGES: readonly TileEdge[] = [256, ...PICTURE_EDGES];

/** The smallest edge at least `needed` device pixels long, or the largest there is. */
export const edgeFor = (needed: number): TileEdge => TILE_EDGES.find((edge) => edge >= needed) ?? 2048;

const renditionAt = (edge: TileEdge): PictureSize => (edge === 256 ? `tile` : `e${edge}`);

// Device pixels per CSS pixel, kept current as a window moves to another screen or the reader zooms. A query for the
// ratio now stops matching the moment it changes, which is the one event a browser gives for it.
export const screenScale = ref(globalThis.devicePixelRatio || 1);
const watchScale = (): void => {
    globalThis.matchMedia?.(`(resolution: ${screenScale.value}dppx)`).addEventListener(
        `change`,
        () => {
            screenScale.value = globalThis.devicePixelRatio || 1;
            watchScale();
        },
        { once: true },
    );
};
watchScale();

/** What a tile draws: a picture (a rendition, or a video's frame the daemon cut), or a video to seek into itself. */
export interface TileArt {
    readonly url: string;
    readonly as: "picture" | "video";
    // The long edge the picture was drawn at. The daemon never enlarges one, so a picture whose pixels come back shorter
    // than this is the file's own size.
    readonly edge: TileEdge;
    // What it holds in memory, which the held answers are budgeted by; none for a stream, which the player reads by range.
    readonly bytes: number;
}

// Held answers, least recently asked first. A grid tile's is a few kilobytes and a large look's a few hundred, and
// scrolling back up a long folder should find its pictures already there; past either bound the least recently asked
// go, their URLs with them. A picture already painted stays painted when its URL goes.
const CAP = 512;
const BUDGET_BYTES = 96 * 1024 * 1024;
interface Held {
    readonly art: Promise<TileArt>;
    // Counted once it lands.
    bytes: number;
}
// In flight or settled, so a burst of tiles asking for one file at one edge makes one request.
const held = new Map<string, Held>();
let heldBytes = 0;
// The largest settled picture per version of a file, for a draw that wants something on screen at once: a larger look
// shows what the tile already has while its own size arrives.
const largest = new Map<string, TileArt>();

// A rewritten file (same path, new size) is a new picture.
const versionKey = (entry: WorkspaceTreeEntry): string => `${workspaceAgent.value ?? ``}\n${entry.path} ${entry.size ?? 0}`;
const artKey = (entry: WorkspaceTreeEntry, use: TileEdge | "stream"): string => `${versionKey(entry)}\n${use}`;

interface Drawn {
    readonly blob: Blob;
    readonly edge: TileEdge;
}

// A video's frame as the daemon cut it, or undefined where it cannot: a sandbox without ffmpeg refuses a video as it
// refuses an SVG (415), and one from before the edges refuses the size (400), so the grid tile's frame is asked next.
const posterAt = async (entry: WorkspaceTreeEntry, edge: TileEdge): Promise<Drawn | undefined> => {
    try {
        const blob = await blobOf(`/workspace/thumb?${queryOf(workspaceAgent.value, entry.path, renditionAt(edge))}`, `image/webp`);
        return blob !== undefined ? { blob, edge } : edge === 256 ? undefined : await posterAt(entry, 256);
    } catch (error) {
        if (refusedWith(error, NOT_RENDERED)) {
            return undefined;
        }
        throw error;
    }
};

// A sandbox from before the edges refuses their names. Its viewer's rendition is the picture's own pixels up to 2560
// wide, as sharp as any edge, so it is taken as the largest; past that, the tile's.
const pictureAt = async (entry: WorkspaceTreeEntry, edge: TileEdge): Promise<Drawn | undefined> => {
    const scope = workspaceAgent.value;
    const asked = await pictureBlob(scope, entry.path, renditionAt(edge));
    if (asked !== undefined || edge === 256) {
        return asked === undefined ? undefined : { blob: asked, edge };
    }
    const view = await pictureBlob(scope, entry.path, `view`);
    if (view !== undefined) {
        return { blob: view, edge: 2048 };
    }
    const tile = await pictureBlob(scope, entry.path, `tile`);
    return tile === undefined ? undefined : { blob: tile, edge: 256 };
};

const fetchArt = async (entry: WorkspaceTreeEntry, kind: ThumbnailKind, edge: TileEdge): Promise<TileArt> => {
    // A video's frame first: a player seeking into a film that opens on a fade draws a white card.
    const drawn = kind === `video` ? await posterAt(entry, edge) : await pictureAt(entry, edge);
    if (drawn !== undefined) {
        return { url: URL.createObjectURL(drawn.blob), as: `picture`, edge: drawn.edge, bytes: drawn.blob.size };
    }
    if (kind === `video`) {
        return { url: await mediaUrl(entry.path), as: `video`, edge, bytes: 0 };
    }
    throw new Error(`Nothing to draw for ${entry.path}.`);
};

const forget = (key: string, kept: Held): void => {
    held.delete(key);
    heldBytes -= kept.bytes;
    void kept.art.then(
        (art) => {
            for (const [version, biggest] of largest) {
                if (biggest.url === art.url) {
                    largest.delete(version);
                }
            }
            if (art.url.startsWith(`blob:`)) {
                URL.revokeObjectURL(art.url);
            }
        },
        () => undefined,
    );
};

// Oldest first, never the one just asked for unless it alone is past the budget.
const evict = (): void => {
    for (const [key, kept] of held) {
        if (held.size <= CAP && heldBytes <= BUDGET_BYTES) {
            return;
        }
        forget(key, kept);
    }
};

const once = (key: string, version: string, fetch: () => Promise<TileArt>): Promise<TileArt> => {
    const pending = held.get(key);
    if (pending !== undefined) {
        // Asked again, so it is recent again.
        held.delete(key);
        held.set(key, pending);
        return pending.art;
    }
    const kept: Held = { art: fetch(), bytes: 0 };
    held.set(key, kept);
    kept.art.then(
        (art) => {
            // Forgotten before it landed: forget has its URL.
            if (held.get(key) !== kept) {
                return;
            }
            kept.bytes = art.bytes;
            heldBytes += art.bytes;
            const before = largest.get(version);
            if (art.as === `picture` && (before === undefined || before.edge < art.edge)) {
                largest.set(version, art);
            }
            evict();
        },
        // A failed read is forgotten, so the next look retries rather than failing for the rest of the session.
        () => {
            if (held.get(key) === kept) {
                held.delete(key);
            }
        },
    );
    evict();
    return kept.art;
};

/** What a home tile draws for an entry at `edge` device pixels, fetched once per version of the file and edge. */
export const tileArt = (entry: WorkspaceTreeEntry, kind: ThumbnailKind, edge: TileEdge = 256): Promise<TileArt> =>
    once(artKey(entry, edge), versionKey(entry), () => fetchArt(entry, kind, edge));

/** The largest picture of an entry already on hand, at whatever edge, to draw while a larger one is on its way. */
export const heldArt = (entry: WorkspaceTreeEntry): TileArt | undefined => largest.get(versionKey(entry));

/** A video's own stream, which the quick look plays. */
export const videoStream = async (entry: WorkspaceTreeEntry): Promise<string> =>
    (await once(artKey(entry, `stream`), versionKey(entry), async () => ({ url: await mediaUrl(entry.path), as: `video`, edge: 256, bytes: 0 }))).url;
