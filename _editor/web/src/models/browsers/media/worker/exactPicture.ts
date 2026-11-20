import type { DecodeSeams, FrameLike, Painter } from "./decodeSeams";
import type { ExactCopy, PictureRect } from "../mediaHeader";
import type { DecodedStripe } from "./stripeVideo";

// AN EXACT PICTURE, FOR A VIEWER ON CASTD'S OWN COMPUTER. A media socket that asked for one (MEDIA_LOSSLESS_QUERY) and
// reaches castd on the loopback gets each video frame clipped to the part of its picture that is not exact yet, and,
// once the screen is still, castd's exact pixels of that part. A clipped frame's stripes are each drawn only where
// they meet the clip; an exact copy is drawn as castd read it off its screen.

/** Where a stripe meets a clip: the rows and columns to copy, at (sx, sy) in the stripe and (dx, dy) in the picture. */
export interface StripePart {
    readonly sx: number;
    readonly sy: number;
    readonly dx: number;
    readonly dy: number;
    readonly width: number;
    readonly height: number;
}

/**
 * The part of a decoded stripe, `width` × `height` at row `top` of the picture, that lies inside `clip`; undefined when
 * none does (a clip elsewhere, or an empty one).
 */
export const stripePart = (clip: PictureRect, top: number, width: number, height: number): StripePart | undefined => {
    const left = Math.max(clip.x, 0);
    const right = Math.min(clip.x + clip.width, width);
    const upper = Math.max(clip.y, top);
    const lower = Math.min(clip.y + clip.height, top + height);
    if (right <= left || lower <= upper) {
        return undefined;
    }
    return { sx: left, sy: upper - top, dx: left, dy: upper, width: right - left, height: lower - upper };
};

/**
 * What draws a decoded stripe: all of it at its top row, or where castd clipped its frame only the part inside the
 * clip, at the same place. Undefined when the clip misses the stripe, which then changes nothing on the canvas.
 */
export const stripePainter = ({ frame, top, clip }: DecodedStripe): ((painter: Painter) => void) | undefined => {
    if (clip === undefined) {
        return (painter) => painter.drawImage(frame, 0, top);
    }
    const part = stripePart(clip, top, frame.displayWidth, frame.displayHeight);
    return part === undefined
        ? undefined
        : (painter) => painter.drawImage(frame, part.sx, part.sy, part.width, part.height, part.dx, part.dy, part.width, part.height);
};

/** castd's pixels (B, G, R, unused) as an ImageData's (R, G, B, A), every one opaque. */
export const bgrxToRgba = (pixels: Uint8Array): Uint8ClampedArray<ArrayBuffer> => {
    const rgba = new Uint8ClampedArray(pixels.byteLength - (pixels.byteLength % 4));
    for (let at = 0; at < rgba.length; at += 4) {
        rgba[at] = pixels[at + 2] ?? 0;
        rgba[at + 1] = pixels[at + 1] ?? 0;
        rgba[at + 2] = pixels[at] ?? 0;
        rgba[at + 3] = 255;
    }
    return rgba;
};

// Draws the copy as a VideoFrame of its own pixels, which the browser draws without converting them on this thread;
// false where it makes no such frame.
const drawAsFrame = (painter: Painter, copy: ExactCopy, seams: Pick<DecodeSeams, `bgrxFrame`>): boolean => {
    let frame: FrameLike | undefined;
    try {
        frame = seams.bgrxFrame(copy.pixels, copy.rect.width, copy.rect.height);
        painter.drawImage(frame, copy.rect.x, copy.rect.y);
        return true;
    } catch {
        // allow(silent-catch): a browser with no BGRX VideoFrame takes the copy as ImageData instead.
        return false;
    } finally {
        frame?.close();
    }
};

/** Draws castd's exact copy of a rectangle where it belongs. */
export const paintExact = (painter: Painter, copy: ExactCopy, seams: Pick<DecodeSeams, `bgrxFrame` | `imageData`>): void => {
    const { x, y, width, height } = copy.rect;
    if (width === 0 || height === 0 || drawAsFrame(painter, copy, seams)) {
        return;
    }
    painter.putImageData(seams.imageData(bgrxToRgba(copy.pixels), width, height), x, y);
};
