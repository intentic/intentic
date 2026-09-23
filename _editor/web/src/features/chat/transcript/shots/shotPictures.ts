import { STATE_DIR } from "@intentic/constants";
import { lazyByPath } from "../../../sandbox/client/lazyByPath";
import { sandboxBlob } from "../../../sandbox/client/sandboxClient";
import { SandboxHttpError } from "../../../sandbox/client/sandboxHttpError";

// A conversation's pictures as something an <img> can show, each at the size it is drawn: the daemon's strip tile, its
// full-size view (AVIF where this engine decodes it), and the original file for actual size and download. Read in the
// conversation's own scope, except the sandbox's shared state, which every checkout shares and an archived one still
// reaches.

// `url` undefined is the daemon's final answer that nothing can be drawn there. Undefined for the whole Picture means
// still on its way.
export interface Picture {
    readonly url: string | undefined;
}

// Final answers: a bad path (400), outside the reader's access (403), gone (404), its checkout cleaned up (412), too
// big (413). Anything else says nothing about the file, and lazyByPath retries it.
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
        return typeof probe.decode === `function` ? probe.decode().then(() => probe.naturalWidth > 0, () => false) : false;
    })();
    return avifProbe;
};

// The sandbox's own state is one directory every checkout shares, so a picture in it is read unscoped.
const scopeOf = (agent: string | undefined, path: string): string | undefined => (path.startsWith(`${STATE_DIR}/`) ? undefined : agent);

// One cache key per scope and path: the same path names a different file in a conversation's own checkout.
const keyOf = (agent: string | undefined, path: string): string => `${scopeOf(agent, path) ?? ``}\n${path}`;

const queryOf = (key: string, size?: string): string => {
    const cut = key.indexOf(`\n`);
    const query = new URLSearchParams({ path: key.slice(cut + 1) });
    if (cut > 0) {
        query.set(`agent`, key.slice(0, cut));
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

const readOriginal = async (key: string): Promise<Picture> => ({ url: await objectUrl(`/workspace/raw?${queryOf(key)}`) });

// What the daemon will not re-encode is drawn from the file, which for SVG is small anyway.
const readRendition = (size: `strip` | `view`) => async (key: string): Promise<Picture> => {
    const accept = size === `view` && (await decodesAvif()) ? `image/avif,image/webp` : `image/webp`;
    try {
        return { url: await objectUrl(`/workspace/thumb?${queryOf(key, size)}`, accept) };
    } catch (error) {
        if (refusedWith(error, NOT_RENDERED)) {
            return readOriginal(key);
        }
        throw error;
    }
};

const strips = lazyByPath(readRendition(`strip`));
const views = lazyByPath(readRendition(`view`));
const originals = lazyByPath(readOriginal);

// The top of the picture at a strip tile's 16:10, starting its fetch on first ask.
export const stripOf = (agent: string | undefined, path: string): Picture | undefined => strips.get(keyOf(agent, path));

// The whole picture at its own size, re-encoded; what the viewer and a tool card draw.
export const viewOf = (agent: string | undefined, path: string): Picture | undefined => views.get(keyOf(agent, path));

// The file itself, for a look at actual pixels; moves the whole file, so only on the reader's ask.
export const originalOf = (agent: string | undefined, path: string): Picture | undefined => originals.get(keyOf(agent, path));

// How long a download's object URL outlives the click that started it, in milliseconds.
const DOWNLOAD_HOLD_MS = 10_000;

// Saves the original under its own name, read now rather than held: a download is one use, not something to cache.
export const downloadOriginal = async (agent: string | undefined, path: string): Promise<void> => {
    const url = await objectUrl(`/workspace/raw?${queryOf(keyOf(agent, path))}`);
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
