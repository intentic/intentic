import { STATE_DIR } from "@intentic/constants";
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { lazyByPath } from "../../../client/sandbox/lazyByPath";
import { sandboxBlob } from "../../../client/sandbox/sandboxClient";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { mediaUrl } from "../files/mediaUrl";
import { workspaceAgent } from "../../../app/workspaceScope";
import { quickLookPlan } from "./quickLookContent";

// A workspace file at the size it is drawn: a daemon rendition (`tile`, `gallery`, `strip`, `view`) or its own bytes
// (`original`).

export type PictureSize = "tile" | "gallery" | "strip" | "view" | "original";

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

// One route's answer as an object URL, or undefined for a final refusal; any other failure propagates for lazyByPath.
const objectUrl = async (route: string, accept?: string): Promise<string | undefined> => {
    try {
        return URL.createObjectURL(await sandboxBlob(route, accept === undefined ? undefined : { headers: { accept } }));
    } catch (error) {
        if (refusedWith(error, NOTHING_THERE)) {
            return undefined;
        }
        throw error;
    }
};

// What the daemon will not re-encode is drawn from the file, which for SVG is small anyway.
const pictureUrl = async (scope: string | undefined, path: string, size: PictureSize): Promise<string | undefined> => {
    if (size === `original`) {
        return objectUrl(`/workspace/raw?${queryOf(scope, path)}`);
    }
    const accept = size === `view` && (await decodesAvif()) ? `image/avif,image/webp` : `image/webp`;
    try {
        return await objectUrl(`/workspace/thumb?${queryOf(scope, path, size)}`, accept);
    } catch (error) {
        if (refusedWith(error, NOT_RENDERED)) {
            return objectUrl(`/workspace/raw?${queryOf(scope, path)}`);
        }
        throw error;
    }
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

// The box a tile is drawn in: a grid tile's, or a gallery row's, which stands several times taller.
export type TileSize = "tile" | "gallery";

/** What a tile draws: a picture (a rendition, or a video's frame the daemon cut), or a video to seek into itself. */
export interface TileArt {
    readonly url: string;
    readonly as: "picture" | "video";
}

// Held answers; each is a few kilobytes, and scrolling back up a long folder should find its tiles already there.
const CAP = 512;
// In flight or settled, so a burst of tiles asking for one file makes one request.
const held = new Map<string, Promise<TileArt>>();

// A rewritten file (same path, new size) is a new picture.
const artKey = (entry: WorkspaceTreeEntry, use: TileSize | "stream"): string =>
    `${workspaceAgent.value ?? ``}\n${use}\n${entry.path} ${entry.size ?? 0}`;

// A video's frame as the daemon cut it, or undefined where it cannot: a sandbox without ffmpeg refuses a video as it
// refuses an SVG (415), and one from before video frames refuses the size (400).
const posterUrl = async (entry: WorkspaceTreeEntry, size: TileSize): Promise<string | undefined> => {
    try {
        return await objectUrl(`/workspace/thumb?${queryOf(workspaceAgent.value, entry.path, size)}`, `image/webp`);
    } catch (error) {
        if (refusedWith(error, NOT_RENDERED)) {
            return undefined;
        }
        throw error;
    }
};

const fetchArt = async (entry: WorkspaceTreeEntry, kind: ThumbnailKind, size: TileSize): Promise<TileArt> => {
    if (kind === `video`) {
        // The frame first: a player seeking into a film that opens on a fade draws a white card.
        const poster = await posterUrl(entry, size);
        return poster === undefined ? { url: await mediaUrl(entry.path), as: `video` } : { url: poster, as: `picture` };
    }
    // A sandbox from before the gallery's rendition refuses its name; the grid tile's is the next best.
    const url =
        (await pictureUrl(workspaceAgent.value, entry.path, size)) ??
        (size === `tile` ? undefined : await pictureUrl(workspaceAgent.value, entry.path, `tile`));
    if (url === undefined) {
        throw new Error(`Nothing to draw for ${entry.path}.`);
    }
    return { url, as: `picture` };
};

const evictOldest = (): void => {
    if (held.size <= CAP) {
        return;
    }
    const [oldest] = held;
    if (oldest === undefined) {
        return;
    }
    held.delete(oldest[0]);
    void oldest[1].then(
        ({ url }) => {
            if (url.startsWith(`blob:`)) {
                URL.revokeObjectURL(url);
            }
        },
        () => undefined,
    );
};

const once = (key: string, fetch: () => Promise<TileArt>): Promise<TileArt> => {
    const pending = held.get(key);
    if (pending !== undefined) {
        return pending;
    }
    const loading = fetch();
    held.set(key, loading);
    // A failed read is forgotten, so the next look retries rather than failing for the rest of the session.
    loading.catch(() => held.delete(key));
    evictOldest();
    return loading;
};

/** What a home tile draws for an entry at `size`, fetched once per version of the file. */
export const tileArt = (entry: WorkspaceTreeEntry, kind: ThumbnailKind, size: TileSize = `tile`): Promise<TileArt> =>
    once(artKey(entry, size), () => fetchArt(entry, kind, size));

/** What the quick look draws: a picture's tile rendition, or a video's own stream, which the card plays. */
export const thumbnailUrl = async (entry: WorkspaceTreeEntry, kind: ThumbnailKind): Promise<string> =>
    (kind === `video`
        ? await once(artKey(entry, `stream`), async () => ({ url: await mediaUrl(entry.path), as: `video` }))
        : await tileArt(entry, kind)
    ).url;
