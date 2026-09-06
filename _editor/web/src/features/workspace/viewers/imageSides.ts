/* ARE THE TWO SIDES ACTUALLY TWO PICTURES? The question a binary diff of a screenshot raises and, until this
 * module, could not answer. Two re-captures of the same screen, two exports of the same logo, a PNG squeezed by
 * a different optimiser: all of them arrive as "modified", both panes fill, and the reviewer is left comparing
 * two ~2.6 MB images by eye at 27% zoom, where a changed number in 11px type is a smudge. The honest answer is
 * cheap and the browser already holds everything it needs: both sides' bytes are in memory to be rendered at
 * all, so the file question is a buffer compare and the picture question a decode away.
 *
 * BYTES FIRST, because it is exact and free: equal bytes means the two sides are one file, which git cannot
 * normally produce (a diff exists because something changed) and which therefore also serves as this viewer's
 * own alarm, if a diff source ever hands the same side over twice, the pane says so instead of quietly looking
 * like a broken comparison.
 *
 * PIXELS SECOND, because "the bytes differ" is not the same as "the picture changed", and for a re-exported
 * asset it is the difference between a review that has something to look at and one that does not.
 *
 * Everything here degrades to `undefined`: an image type the browser will paint but not decode into a canvas
 * (some ICOs), a canvas call a hardened context refuses, an image too large to be worth comparing. Unknown is
 * reported as unknown, never as a verdict. */

/* What the two sides turn out to be. `undefined` is "nothing to add": the two pictures are different shapes,
 * which the captions already say, or nothing here could decode them.
 *
 * `changed` carries a share rather than a bare "they differ" because that is the case a reviewer is stuck on:
 * two captures of one screen at one size, where the captions agree down to the rounded byte count and the
 * only honest report is HOW MUCH moved. 0.2% says "one figure changed, go and find it"; 40% says "this is a
 * different screen". */
export type SidesComparison = { readonly kind: "bytes" } | { readonly kind: "pixels" } | { readonly kind: "changed"; readonly share: number };

export interface ImageSize {
    readonly w: number;
    readonly h: number;
}

/* Above this the pixel pass is skipped. Two 8K screenshots are 66 MP a side, and comparing them means two full
 * RGBA decodes (~265 MB each) to answer a question the byte compare has already answered "not the same file"
 * for. The pass is an extra courtesy for the common case, not a promise about every case. */
const MAX_COMPARED_PIXELS = 40_000_000;

const sameBytes = async (before: Blob, after: Blob): Promise<boolean> => {
    if (before.size !== after.size) {
        return false;
    }
    const [left, right] = await Promise.all([before.arrayBuffer(), after.arrayBuffer()]);
    const a = new Uint8Array(left);
    const b = new Uint8Array(right);
    return a.every((byte, index) => byte === b[index]);
};

// The picture's own size, which is the one fact that distinguishes two screenshots at a glance and the one the
// caption could not previously report. Decoded rather than parsed out of the container: every renderable type
// answers, and none of their headers has to be understood here.
export const imageSize = async (blob: Blob): Promise<ImageSize | undefined> => {
    if (typeof createImageBitmap !== `function`) {
        return undefined;
    }
    try {
        const bitmap = await createImageBitmap(blob);
        const size = { w: bitmap.width, h: bitmap.height };
        bitmap.close();
        return size;
    } catch {
        return undefined;
    }
};

/* Somewhere to decode into, which is never shown: an offscreen surface where the browser has one (no document,
 * no layout), a detached <canvas> otherwise. `willReadFrequently` because reading the whole surface straight
 * back IS the purpose here, and it keeps the context on the CPU rather than paying a GPU readback for a
 * one-shot compare.
 *
 * Typed as the on-screen context: OffscreenCanvas's differs only in what it is attached to, and the two calls
 * made below (drawImage, getImageData) are the same method on both. */
const context2d = (size: ImageSize): CanvasRenderingContext2D | undefined => {
    if (typeof OffscreenCanvas === `function`) {
        return (new OffscreenCanvas(size.w, size.h).getContext(`2d`, { willReadFrequently: true }) as CanvasRenderingContext2D | null) ?? undefined;
    }
    if (typeof document === `undefined`) {
        return undefined;
    }
    const canvas = document.createElement(`canvas`);
    canvas.width = size.w;
    canvas.height = size.h;
    return canvas.getContext(`2d`, { willReadFrequently: true }) ?? undefined;
};

const pixelsOf = async (blob: Blob, size: ImageSize): Promise<Uint8ClampedArray | undefined> => {
    const context = context2d(size);
    if (context === undefined) {
        return undefined;
    }
    try {
        const bitmap = await createImageBitmap(blob);
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return context.getImageData(0, 0, size.w, size.h).data;
    } catch {
        return undefined;
    }
};

/* How many pixels of the two are not the same pixel. Counted rather than stopped at the first difference: the
 * count IS the answer here, and a full pass over a fitted-in-a-pane screenshot costs a few milliseconds off
 * the render path. A pixel counts as changed if any of its four channels moved, no tolerance: a re-encode that
 * shifts a channel by one is a real difference in the file, and the caller reports the share, not a verdict
 * about whether it matters. */
const changedShare = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
    let changed = 0;
    for (let index = 0; index < a.length; index += 4) {
        if (a[index] !== b[index] || a[index + 1] !== b[index + 1] || a[index + 2] !== b[index + 2] || a[index + 3] !== b[index + 3]) {
            changed++;
        }
    }
    return changed / (a.length / 4);
};

/* The comparison, in the order that costs the least: equal bytes ⇒ one file; different dimensions ⇒ two
 * pictures, which the captions already show and no decode is needed to say; otherwise the pixels decide. */
export const compareSides = async (before: Blob, after: Blob): Promise<SidesComparison | undefined> => {
    if (await sameBytes(before, after)) {
        return { kind: `bytes` };
    }
    const [left, right] = await Promise.all([imageSize(before), imageSize(after)]);
    if (left === undefined || right === undefined || left.w !== right.w || left.h !== right.h) {
        return undefined;
    }
    if (left.w * left.h > MAX_COMPARED_PIXELS) {
        return undefined;
    }
    const [a, b] = await Promise.all([pixelsOf(before, left), pixelsOf(after, right)]);
    if (a === undefined || b === undefined || a.length !== b.length) {
        return undefined;
    }
    const share = changedShare(a, b);
    return share === 0 ? { kind: `pixels` } : { kind: `changed`, share };
};
