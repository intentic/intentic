// THE PAGE'S BACKGROUND AS A PICTURE'S EDGES SHOW IT, for what shows beside a picture smaller than its box
// (pictureFit.ts). Read on the main thread off the legacy video canvas (videoSink.ts) and in the decode worker off the
// media path's OffscreenCanvas (media/worker/decodeCore.ts), so it depends on nothing either side lacks.

// How many points along each edge the edge colour is read from, and how far in from the right the column is read: past
// a classic scrollbar, which is the scrollbar's grey rather than the page's own background.
const EDGE_SAMPLES = 64;
const SCROLLBAR_PX = 20;
// The share of samples one colour needs to count as the page's background rather than whatever runs to its edge.
const EDGE_MAJORITY = 0.25;

// The commonest colour among pixels, by 5 bits a channel so a video's ±1 noise on a flat white counts as one colour;
// undefined when none holds EDGE_MAJORITY of them. A pixel not fully opaque is a canvas nothing has painted yet, which
// would otherwise read as black, and counts for no colour.
export const commonColour = (pixels: Uint8ClampedArray): string | undefined => {
    const counts = new Map<number, number>();
    let best: number | undefined;
    let bestCount = 0;
    for (let at = 0; at + 3 < pixels.length; at += 4) {
        if (pixels[at + 3] !== 255) {
            continue;
        }
        const key = ((pixels[at]! >> 3) << 10) | ((pixels[at + 1]! >> 3) << 5) | (pixels[at + 2]! >> 3);
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (count > bestCount) {
            bestCount = count;
            best = at;
        }
    }
    if (best === undefined || bestCount < (pixels.length / 4) * EDGE_MAJORITY) {
        return undefined;
    }
    return `rgb(${pixels[best]} ${pixels[best + 1]} ${pixels[best + 2]})`;
};

// A 2D context the edges are copied into to be read: either kind of canvas has one.
type Probe = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * The edge colour of a painted picture: a column just inside its right edge and its bottom row, each copied into a row
 * of `probe` pixel for pixel, never blended. Read through a small probe, since reading the picture's own canvas back
 * makes Chromium move it off the GPU, which a live picture cannot afford.
 */
export const readEdgeColour = (source: CanvasImageSource & { readonly width: number; readonly height: number }, probe: Probe): string | undefined => {
    if (source.width <= SCROLLBAR_PX || source.height < 2) {
        return undefined;
    }
    probe.canvas.width = EDGE_SAMPLES;
    probe.canvas.height = EDGE_SAMPLES + 1;
    probe.imageSmoothingEnabled = false;
    probe.drawImage(source, 0, source.height - 1, source.width - SCROLLBAR_PX, 1, 0, 0, EDGE_SAMPLES, 1);
    probe.drawImage(source, source.width - SCROLLBAR_PX, 0, 1, source.height, 0, 1, 1, EDGE_SAMPLES);
    const row = probe.getImageData(0, 0, EDGE_SAMPLES, 1).data;
    const column = probe.getImageData(0, 1, 1, EDGE_SAMPLES).data;
    const both = new Uint8ClampedArray(row.length + column.length);
    both.set(row);
    both.set(column, row.length);
    return commonColour(both);
};
