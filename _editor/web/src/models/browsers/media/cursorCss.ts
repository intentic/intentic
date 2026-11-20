import type { MediaCursor } from "@intentic/sandbox-contract/browser-wire";

// The pointer's look over the picture, as castd reports it (`cursor`): a CSS keyword where the X cursor is a standard
// one, else the X cursor's own image, a PNG in the picture's pixels with its hotspot. The picture is drawn 1:1 in
// device pixels, so an image `scale` device pixels per CSS pixel is given as an image-set at that density: without it
// a DPR-2 screen shows every cursor twice its size. A hotspot is in CSS px then, as the browser reads it beside an
// image-set.

// A CSS cursor keyword: what castd may send, and nothing that could close the declaration or open a url().
const KEYWORD = /^[a-z-]{1,24}$/;
// Base64 as castd writes it; anything else in a url() could break out of it.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const keyword = (css: string | undefined, fallback: string): string => (css !== undefined && KEYWORD.test(css) ? css : fallback);

/**
 * The stage's CSS `cursor` for castd's cursor at `scale`; `imageSet` says whether this browser takes an image-set in a
 * cursor (CSS.supports), where a plain url() at the image's own size is the fallback.
 */
export const cursorCss = (cursor: MediaCursor | undefined, scale: number, imageSet: boolean): string => {
    if (cursor === undefined) {
        return `default`;
    }
    const png = cursor.png;
    // The keyword stands behind the image, for a browser that refuses the image (too large, a bad decode).
    const behind = keyword(cursor.css, `default`);
    if (png === undefined || png === `` || !BASE64.test(png)) {
        return behind;
    }
    const url = `url("data:image/png;base64,${png}")`;
    const density = imageSet && Number.isFinite(scale) && scale > 0 && scale !== 1 ? scale : 1;
    const hotX = Math.max(0, Math.round((cursor.hotX ?? 0) / density));
    const hotY = Math.max(0, Math.round((cursor.hotY ?? 0) / density));
    const image = density === 1 ? url : `image-set(${url} ${density}x)`;
    return `${image} ${hotX} ${hotY}, ${behind}`;
};

// Whether this browser takes an image-set in `cursor`; asked once, since it cannot change.
let imageSetCursor: boolean | undefined;
export const supportsImageSetCursor = (): boolean => {
    imageSetCursor ??= `CSS` in globalThis && CSS.supports(`cursor`, `image-set(url("data:,") 2x) 0 0, auto`);
    return imageSetCursor;
};
