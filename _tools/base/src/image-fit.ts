// The size a screen capture is shown to a model at. Past these limits a model API shrinks the image itself and says
// nothing, so every coordinate read off it lands short of where it was aimed, and the bytes past them cross the link
// for nothing. Shared by every device that captures a screen: the desktop agent, and the Chrome extension.

export interface ImageLimits {
    // The longest edge an image may have.
    readonly maxEdge: number;
    // Its area. Claude reads about 1.15 megapixels whole; a 16:9 frame meets the edge first, a 16:10 one the area.
    readonly maxPixels: number;
}

export const MODEL_IMAGE_LIMITS = { maxEdge: 1456, maxPixels: 1_150_000 } satisfies ImageLimits;

// The size a `width`×`height` capture is shown at: shrunk to fit both limits, never enlarged.
export const fitSize = (width: number, height: number, limits: ImageLimits = MODEL_IMAGE_LIMITS) => {
    const scale = Math.min(1, limits.maxEdge / Math.max(width, height), Math.sqrt(limits.maxPixels / (width * height)));
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
};
