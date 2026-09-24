// Answers whether a binary image diff's two sides are actually different pictures, not just different bytes.
// Bytes compared first (exact, free, and catches a diff source handing the same side twice); pixels compared
// second, since differing bytes don't mean the picture changed. Undecodable images degrade to undefined.

// `undefined`: different shapes (captions already say so) or nothing decodable. `changed` carries a share, not
// a bare "differ": 0.2% says find one changed figure, 40% says a different screen.
export type SidesComparison = { readonly kind: "bytes" } | { readonly kind: "pixels" } | { readonly kind: "changed"; readonly share: number };

export interface ImageSize {
    readonly w: number;
    readonly h: number;
}

// Above this, the pixel pass is skipped: decoding both sides fully costs too much for a courtesy check.
const MAX_COMPARED_PIXELS = 40_000_000;

// Four bytes a step through the aligned body, then the odd tail bytes; a per-byte callback was the slow half of this.
const sameBytes = async (before: Blob, after: Blob): Promise<boolean> => {
    if (before.size !== after.size) {
        return false;
    }
    const [left, right] = await Promise.all([before.arrayBuffer(), after.arrayBuffer()]);
    const words = left.byteLength >> 2;
    const a = new Uint32Array(left, 0, words);
    const b = new Uint32Array(right, 0, words);
    for (let index = 0; index < words; index++) {
        if (a[index] !== b[index]) {
            return false;
        }
    }
    const tailA = new Uint8Array(left, words << 2);
    const tailB = new Uint8Array(right, words << 2);
    return tailA.every((byte, index) => byte === tailB[index]);
};

// The picture's own size, decoded rather than parsed from the container: every renderable type answers, no
// header format needs understanding here.
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

// Offscreen canvas where available, else a detached one; `willReadFrequently` keeps it on the CPU, since reading
// the whole surface back is the point. Typed as the on-screen context, since the methods used here are identical on
// both.
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

// Counts every changed pixel, not just the first, since the count is the answer. Any channel difference counts,
// no tolerance: a real difference, with the caller reporting share, not a verdict. One RGBA pixel is one 32-bit word.
const changedShare = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
    const left = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2);
    const right = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
    let changed = 0;
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) {
            changed++;
        }
    }
    return changed / left.length;
};

// Cheapest check first: equal bytes ⇒ one file; different dimensions ⇒ two pictures (captions already show
// that, no decode needed); otherwise pixels decide.
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
