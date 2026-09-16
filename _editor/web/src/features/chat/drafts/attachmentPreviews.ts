import { isAudioPath, isImagePath } from "./filePeek";
import { lazyByPath } from "../../sandbox/client/lazyByPath";
import { sandboxBlob } from "../../sandbox/client/sandboxClient";

// An attachment's own bytes as something an element can be pointed at, per workspace path — the thumbnail a picture
// shows and the source a sound plays, one cache because one path is one fetch. `rememberMedia` seeds the composer's
// own upload; everything else re-fetches from /workspace/raw on first ask, under lazyByPath's boot race (retry
// transport failures, park on a daemon refusal).

// What the bytes ARE, kept beside the URL rather than re-derived from the path: a staged upload is typed by the
// composer (image/*, audio/*) whatever it is named, and an `<img>` pointed at a sound draws a broken picture.
export type MediaKind = "image" | "audio";

interface Media {
    readonly kind: MediaKind;
    readonly url: string;
}

const kindOfPath = (path: string): MediaKind | undefined =>
    isImagePath(path) ? `image` : isAudioPath(path) ? `audio` : undefined;

const media = lazyByPath(async (path: string): Promise<Media> => ({
    // Only reached for a path whose extension already named a kind, so this never disagrees with the cached one.
    kind: kindOfPath(path) ?? `image`,
    url: URL.createObjectURL(await sandboxBlob(`/workspace/raw?path=${encodeURIComponent(path)}`)),
}));

// The bytes are already in this window, filed under the path they were uploaded to; called by the composer as
// it stages a file.
export const rememberMedia = (path: string, kind: MediaKind, url: string): void => {
    media.put(path, { kind, url });
};

// Drops a path whose staged object URL was just revoked, so the cache doesn't hand out a dead URL. Only ever
// a file that was never sent.
export const forgetMedia = (path: string): void => {
    media.drop(path);
};

// Cached URL for an attachment path IF its bytes are of the asked-for kind, kicking off the fetch on first ask.
// Undefined for the wrong kind, for in-flight fetches, and for refused paths; the caller draws a file chip until it
// resolves.
const mediaOf = (path: string, kind: MediaKind): string | undefined => {
    const held = media.cached(path);
    if (held !== undefined) {
        return held.kind === kind ? held.url : undefined;
    }
    return kindOfPath(path) === kind ? media.get(path)?.url : undefined;
};

export const attachmentPreview = (path: string): string | undefined => mediaOf(path, `image`);
export const attachmentAudio = (path: string): string | undefined => mediaOf(path, `audio`);

// Which chip an attachment gets, asked before either URL exists so the composer and the sent bubble pick the same
// face from the same answer. What this window staged wins over what the path is called; a restored attachment has
// only its name to go on. Undefined is a file chip.
export const attachmentKind = (path: string): MediaKind | undefined => media.cached(path)?.kind ?? kindOfPath(path);
