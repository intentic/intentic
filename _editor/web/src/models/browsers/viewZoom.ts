// Pinching the picture on a phone or tablet magnifies it HERE, as a CSS transform of the picture's box, and leaves the
// remote page as it is: what a person does to read small text, never a change of the page's layout. Pointer input
// needs nothing of this module, since it measures the picture's on-screen box (viewportCoords.ts), which the transform
// already moved and scaled. The view never shows less than the whole box would at rest: zoomed out to 1 it is reset,
// and zoomed in it is kept covering the box, as an image viewer keeps a picture under the fingers.

// At most this many times its resting size; past it a picture pixel is a blur, not a detail.
const MAX_ZOOM = 5;

export interface ZoomState {
    readonly scale: number;
    readonly x: number;
    readonly y: number;
}

const REST: ZoomState = { scale: 1, x: 0, y: 0 };

// The box being zoomed as it would be laid out at rest, in client pixels.
export interface ZoomBox {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

export interface ViewZoom {
    // The box's untransformed layout, measured at the start of a gesture (`measure` below).
    readonly begin: (x: number, y: number, spread: number, box: ZoomBox) => void;
    // The fingers' centroid and spread now: the point under them at `begin` stays under them.
    readonly pinch: (x: number, y: number, spread: number) => void;
    // Moves a zoomed view by this many client pixels, and answers what it could not move (at an edge), which the
    // caller scrolls the page by instead.
    readonly pan: (dx: number, dy: number) => readonly [number, number];
    readonly reset: () => void;
    readonly state: () => ZoomState;
}

// An axis' offset that keeps a box `size` long covering the `view` it is clipped to.
const clampOffset = (offset: number, size: number, view: number): number => Math.min(0, Math.max(view - size, offset));

/** The CSS a zoom state draws with; undefined at rest, so the picture keeps no transform it does not need. */
export const zoomStyle = (state: ZoomState): { transform: string; transformOrigin: string } | undefined =>
    state.scale === 1 ? undefined : { transform: `translate(${state.x}px, ${state.y}px) scale(${state.scale})`, transformOrigin: `0 0` };

/** The box's resting layout from its transformed one, given the zoom drawing it now (origin at its top-left). */
export const restingBox = (rect: ZoomBox, state: ZoomState): ZoomBox => ({
    left: rect.left - state.x,
    top: rect.top - state.y,
    width: rect.width / state.scale,
    height: rect.height / state.scale,
});

export const viewZoom = (onChange: (state: ZoomState) => void): ViewZoom => {
    let state = REST;
    let box: ZoomBox = { left: 0, top: 0, width: 0, height: 0 };
    let from = { ...REST, x0: 0, y0: 0, spread: 1 };

    const set = (scale: number, x: number, y: number): void => {
        const clamped = Math.min(MAX_ZOOM, Math.max(1, scale));
        state =
            clamped === 1
                ? REST
                : { scale: clamped, x: clampOffset(x, box.width * clamped, box.width), y: clampOffset(y, box.height * clamped, box.height) };
        onChange(state);
    };

    return {
        begin: (x, y, spread, measured) => {
            box = measured;
            from = { ...state, x0: x, y0: y, spread: Math.max(1, spread) };
        },
        pinch: (x, y, spread) => {
            const scale = Math.min(MAX_ZOOM, Math.max(1, (from.scale * Math.max(1, spread)) / from.spread));
            // The point of the resting box that was under the fingers when they landed.
            const restX = (from.x0 - box.left - from.x) / from.scale;
            const restY = (from.y0 - box.top - from.y) / from.scale;
            set(scale, x - box.left - scale * restX, y - box.top - scale * restY);
        },
        pan: (dx, dy) => {
            if (state.scale === 1) {
                return [dx, dy];
            }
            const before = state;
            set(state.scale, state.x + dx, state.y + dy);
            return [dx - (state.x - before.x), dy - (state.y - before.y)];
        },
        reset: () => {
            if (state !== REST) {
                state = REST;
                onChange(state);
            }
        },
        state: () => state,
    };
};
