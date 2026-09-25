import { STATE_DIR } from "@intentic/constants";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { lazyByPath } from "../../sandbox/client/lazyByPath";
import { sandboxBlob } from "../../sandbox/client/sandboxClient";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { mediaUrl } from "../files/mediaUrl";
import { workspaceAgent } from "../health/workspaceScope";
import { quickLookPlan } from "./quickLookContent";

// A workspace file at the size it is drawn: a daemon rendition (`tile`, `strip`, `view`) or its own bytes (`original`).

export type PictureSize = "tile" | "strip" | "view" | "original";

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

// One entry per size, scope and path: the same path names a different file in a conversation's own checkout.
const keyOf = (scope: string | undefined, path: string, size: PictureSize): string =>
    JSON.stringify([size, path.startsWith(`${STATE_DIR}/`) ? undefined : scope, path]);

const pictures = lazyByPath(async (key: string): Promise<Picture> => {
    const [size, scope, path] = JSON.parse(key) as [PictureSize, string | null, string];
    return { url: await pictureUrl(scope ?? undefined, path, size) };
});

// The picture at `size`, starting its fetch on first ask.
export const picture = (scope: string | undefined, path: string, size: PictureSize): Picture | undefined => pictures.get(keyOf(scope, path, size));

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

// Held URLs; each is a few kilobytes, and scrolling back up a long folder should find its tiles already there.
const CAP = 512;
// In flight or settled, so a burst of tiles asking for one file makes one request.
const urls = new Map<string, Promise<string>>();

// A rewritten file (same path, new size) is a new picture.
const tileKey = (entry: WorkspaceTreeEntry): string => `${workspaceAgent.value ?? ``}\n${entry.path} ${entry.size ?? 0}`;

const fetchTile = async (entry: WorkspaceTreeEntry, kind: ThumbnailKind): Promise<string> => {
    if (kind === `video`) {
        return mediaUrl(entry.path);
    }
    const url = await pictureUrl(workspaceAgent.value, entry.path, `tile`);
    if (url === undefined) {
        throw new Error(`Nothing to draw for ${entry.path}.`);
    }
    return url;
};

const evictOldest = (): void => {
    if (urls.size <= CAP) {
        return;
    }
    const [oldest] = urls;
    if (oldest === undefined) {
        return;
    }
    urls.delete(oldest[0]);
    void oldest[1].then(
        (url) => {
            if (url.startsWith(`blob:`)) {
                URL.revokeObjectURL(url);
            }
        },
        () => undefined,
    );
};

export const thumbnailUrl = (entry: WorkspaceTreeEntry, kind: ThumbnailKind): Promise<string> => {
    const key = tileKey(entry);
    const pending = urls.get(key);
    if (pending !== undefined) {
        return pending;
    }
    const loading = fetchTile(entry, kind);
    urls.set(key, loading);
    // A failed read is forgotten, so the next look retries rather than failing for the rest of the session.
    loading.catch(() => urls.delete(key));
    evictOldest();
    return loading;
};
