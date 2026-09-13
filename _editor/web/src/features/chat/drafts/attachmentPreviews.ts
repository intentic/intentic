import { isImagePath } from "./filePeek";
import { lazyByPath } from "../../sandbox/client/lazyByPath";
import { sandboxBlob } from "../../sandbox/client/sandboxClient";

// Thumbnail cache for an attachment's workspace path, shared by the composer chip, sent bubbles, and restored
// transcripts. `rememberPreview` seeds the composer's own upload; everything else re-fetches from /workspace/raw on
// first ask, under lazyByPath's boot race (retry transport failures, park on a daemon refusal).

const previews = lazyByPath(async (path: string) =>
    URL.createObjectURL(await sandboxBlob(`/workspace/raw?path=${encodeURIComponent(path)}`)),
);

// The bytes are already in this window, filed under the path they were uploaded to; called by the composer as
// it stages a file.
export const rememberPreview = (path: string, url: string): void => {
    previews.put(path, url);
};

// Drops a path whose staged object URL was just revoked, so the cache doesn't hand out a dead URL. Only ever
// a file that was never sent.
export const forgetPreview = (path: string): void => {
    previews.drop(path);
};

// Cached preview URL for an attachment path, kicking off the fetch on first ask. Undefined for non-images,
// in-flight fetches, and refused paths; the caller renders a file chip until it resolves. A staged upload answers
// from its own object URL whatever it is named, since the composer typed those bytes as an image, not the path did.
export const attachmentPreview = (path: string): string | undefined =>
    previews.cached(path) ?? (isImagePath(path) ? previews.get(path) : undefined);
