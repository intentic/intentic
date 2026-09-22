import { lazyByPath } from "../../../sandbox/client/lazyByPath";
import { SandboxHttpError, sandboxBlob } from "../../../sandbox/client/sandboxClient";

// A conversation's pictures as something an <img> can show, in two sizes: the daemon's tile-sized WebP for strips and
// filmstrips, the file itself for the viewer and tool cards. Read in the conversation's own scope (`agent`), since a
// picture an isolated agent read may exist only in its checkout, and the daemon falls back to the shared tree.

// `url` undefined is the daemon's final answer that nothing can be drawn there: aged out, gone with its checkout, or
// outside the reader's access. Undefined for the whole Picture means still on its way.
export interface Picture {
    readonly url: string | undefined;
}

// Statuses that mean the bytes will never come, as opposed to a daemon still booting (lazyByPath retries those).
const NOTHING_THERE = new Set([400, 403, 404, 413]);

// The daemon's word for "not a picture I will downscale" (SVG, whose markup it won't rasterise).
const NOT_THUMBNAILABLE = 415;

// One cache key per scope and path: the same path names a different file in a conversation's own checkout.
const keyOf = (agent: string | undefined, path: string): string => `${agent ?? ``}\n${path}`;

const queryOf = (key: string): string => {
    const cut = key.indexOf(`\n`);
    const query = new URLSearchParams({ path: key.slice(cut + 1) });
    if (cut > 0) {
        query.set(`agent`, key.slice(0, cut));
    }
    return query.toString();
};

const refusedWith = (error: unknown, statuses: ReadonlySet<number>): boolean => error instanceof SandboxHttpError && statuses.has(error.status);

const fileAt = async (key: string): Promise<Picture> => {
    try {
        return { url: URL.createObjectURL(await sandboxBlob(`/workspace/raw?${queryOf(key)}`)) };
    } catch (error) {
        if (refusedWith(error, NOTHING_THERE)) {
            return { url: undefined };
        }
        throw error;
    }
};

// The daemon decides what it can downscale; what it refuses is drawn from the file, which for SVG is small anyway.
const tileAt = async (key: string): Promise<Picture> => {
    try {
        return { url: URL.createObjectURL(await sandboxBlob(`/workspace/thumb?${queryOf(key)}`)) };
    } catch (error) {
        if (refusedWith(error, new Set([NOT_THUMBNAILABLE]))) {
            return fileAt(key);
        }
        if (refusedWith(error, NOTHING_THERE)) {
            return { url: undefined };
        }
        throw error;
    }
};

const files = lazyByPath(fileAt);
const tiles = lazyByPath(tileAt);

// The picture itself, starting its fetch on first ask.
export const pictureAt = (agent: string | undefined, path: string): Picture | undefined => files.get(keyOf(agent, path));

// The same picture at tile size, starting its fetch on first ask.
export const tileOf = (agent: string | undefined, path: string): Picture | undefined => tiles.get(keyOf(agent, path));
