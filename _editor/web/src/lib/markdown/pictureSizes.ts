import { z } from "zod";
import { activeSandboxId } from "../../app/storage/activeSandbox";
import { pictureSizesKey, storedJson, storeJson } from "../../app/storage/browserStorage";
import { whenIdle } from "../whenIdle";

// THE SIZE A DOCUMENT'S PICTURE CAME OUT AT LAST TIME, so the placeholder drawn while its bytes load next time is that
// size, rather than a guessed 16:9 box the picture then grows or shrinks out of, pushing the page about. Each workspace
// picture a markdown document draws (markdownImages.ts) carries its path; when it loads, its natural size is kept here,
// per sandbox, in localStorage: read synchronously, so the very first frame of a reopened document already holds each
// picture's room. A picture rewritten at another size is simply measured again when it lands.

export interface NaturalSize {
    readonly width: number;
    readonly height: number;
}

// Width, height, and when it was last seen: the newest few hundred per sandbox are kept, the rest forgotten.
type Kept = readonly [number, number, number];

const KEPT_PER_SANDBOX = 400;
// An unchanged size is rewritten only this often, enough for trimming to see the picture is still opened.
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

const KeptSchema = z.record(z.string(), z.tuple([z.number().int().positive(), z.number().int().positive(), z.number()]));

// allow(module-state): one memory for the page, each entry already keyed by its sandbox
const held = new Map<string, Map<string, Kept>>();
const unsaved = new Set<string>();

const scopeNow = (): string => activeSandboxId.value ?? `none`;

const sizesIn = (scope: string): Map<string, Kept> => {
    let sizes = held.get(scope);
    if (sizes === undefined) {
        sizes = new Map(Object.entries(storedJson(pictureSizesKey(scope), KeptSchema) ?? {}));
        held.set(scope, sizes);
    }
    return sizes;
};

const save = (): void => {
    for (const scope of unsaved) {
        const newest = [...sizesIn(scope)].toSorted(([, left], [, right]) => right[2] - left[2]).slice(0, KEPT_PER_SANDBOX);
        held.set(scope, new Map(newest));
        storeJson(pictureSizesKey(scope), Object.fromEntries(newest));
    }
    unsaved.clear();
};

/** The size the picture at workspace `path` was drawn at when it last loaded in this sandbox, if it ever did. */
export const pictureSizeOf = (path: string): NaturalSize | undefined => {
    const kept = sizesIn(scopeNow()).get(path);
    return kept === undefined ? undefined : { width: kept[0], height: kept[1] };
};

/** Keeps the size the picture at workspace `path` loaded at, written at the page's next idle moment. */
const rememberPictureSize = (path: string, size: NaturalSize, now: number = Date.now()): void => {
    const width = Math.round(size.width);
    const height = Math.round(size.height);
    if (width <= 0 || height <= 0) {
        return;
    }
    const scope = scopeNow();
    const sizes = sizesIn(scope);
    const kept = sizes.get(path);
    if (kept !== undefined && kept[0] === width && kept[1] === height && now - kept[2] < TOUCH_AFTER_MS) {
        return;
    }
    sizes.set(path, [width, height, now]);
    if (unsaved.size === 0) {
        whenIdle(save);
    }
    unsaved.add(scope);
};

/**
 * What a picture on its way draws when its size is known: an empty, transparent SVG of exactly that size. Its natural
 * size and ratio are the picture's, so the browser lays the placeholder out as it will lay out the picture (its own
 * `width`/`height` attributes, the column's `max-width`, a height that follows the ratio), and swapping in the real
 * bytes moves nothing.
 */
export const sizedPlaceholder = ({ width, height }: NaturalSize): string =>
    `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`)}`;

let measuring = false;

// One listener for the page, catching every document picture's `load` on its way down (load does not bubble): a picture
// that has its bytes and carries its path is measured. The placeholder is skipped, since it is the size it was given.
const measure = (event: Event): void => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || image.hasAttribute(`data-md-pending`)) {
        return;
    }
    const path = image.dataset[`mdPicture`];
    if (path !== undefined && path !== `` && image.naturalWidth > 0 && image.naturalHeight > 0) {
        rememberPictureSize(path, { width: image.naturalWidth, height: image.naturalHeight });
    }
};

/** Starts measuring every document picture that loads in this page. Idempotent; a page without a document does nothing. */
export const measurePictures = (): void => {
    if (measuring || globalThis.document === undefined) {
        return;
    }
    measuring = true;
    globalThis.document.addEventListener(`load`, measure, true);
};
