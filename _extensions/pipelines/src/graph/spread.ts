// How a left-to-right job graph uses its frame. The frame's width goes to the cards and the gutters between columns,
// not to margins: the zoom is the largest that keeps every gutter at least GUTTER_PX wide on screen, and whatever width
// is left at that zoom widens the gutters, so a short run spreads out and a long one stays as large as it can.

// Rendered width a gutter keeps at any zoom: room for an elbow's two turns and the lanes that run along it.
export const GUTTER_PX = 48;
// Bounds on the gutter in graph px: never tighter than at full size, and never so wide a short run reads as scattered.
export const RANK_SEP_MIN = 48;
export const RANK_SEP_MAX = 112;
// Below LEGIBLE_FIT the whole run is not worth showing at once: it is shown at READABLE_ZOOM from its start instead,
// cropped, to be panned or opened full screen.
export const LEGIBLE_FIT = 0.45;
export const READABLE_ZOOM = 0.8;
// Gutters move in steps, so a window resized a pixel at a time does not lay the graph out again at every pixel.
const STEP = 4;

export interface SpreadInput {
    // The columns' widths added up, and how many columns there are.
    readonly cardsWidth: number;
    readonly columns: number;
    // The tallest column's height, cards and the gaps between them.
    readonly contentHeight: number;
    // The room the picture may take, margins already taken off.
    readonly frameWidth: number;
    readonly frameHeight: number;
}

export interface Spread {
    readonly zoom: number;
    readonly rankSep: number;
    // Shown at READABLE_ZOOM from its start rather than whole.
    readonly cropped: boolean;
}

export const spreadColumns = ({ cardsWidth, columns, contentHeight, frameWidth, frameHeight }: SpreadInput): Spread => {
    const gaps = Math.max(0, columns - 1);
    if (cardsWidth <= 0 || contentHeight <= 0) {
        return { zoom: 1, rankSep: RANK_SEP_MIN, cropped: false };
    }
    const byWidth = (frameWidth - gaps * GUTTER_PX) / cardsWidth;
    const zoom = Math.min(1, byWidth, frameHeight / contentHeight);
    if (zoom < LEGIBLE_FIT) {
        return { zoom: READABLE_ZOOM, rankSep: Math.max(RANK_SEP_MIN, Math.ceil(GUTTER_PX / READABLE_ZOOM)), cropped: true };
    }
    if (gaps === 0) {
        return { zoom, rankSep: RANK_SEP_MIN, cropped: false };
    }
    // Floored to a step, so the picture still fits the width it was solved for.
    const filling = Math.floor((frameWidth / zoom - cardsWidth) / gaps / STEP) * STEP;
    return { zoom, rankSep: Math.min(RANK_SEP_MAX, Math.max(RANK_SEP_MIN, filling)), cropped: false };
};
