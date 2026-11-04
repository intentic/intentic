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
const LEGIBLE_FIT = 0.45;
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

// Top to bottom, a run is read down the page rather than fitted into a band: it is drawn at the largest zoom its widest
// line allows, up to full size, and is as tall as that makes it, however tall, so the page scrolls through it. Its
// stages wrap at the frame's width (wrapLines), so only a card wider than the frame itself shrinks it; one too narrow to
// read even then starts from its left edge at READABLE_ZOOM, to be panned or opened full screen.
// The gutter between rows: room for a line's sweep from one lane to another on its way down, and no more, since the
// run's length is height.
export const ROW_GAP = 48;

export interface RowSpreadInput {
    // The widest row's cards and the gaps between them.
    readonly contentWidth: number;
    readonly frameWidth: number;
}

export const spreadRows = ({ contentWidth, frameWidth }: RowSpreadInput): Spread => {
    if (contentWidth <= 0) {
        return { zoom: 1, rankSep: ROW_GAP, cropped: false };
    }
    const zoom = Math.min(1, frameWidth / contentWidth);
    return zoom < LEGIBLE_FIT ? { zoom: READABLE_ZOOM, rankSep: ROW_GAP, cropped: true } : { zoom, rankSep: ROW_GAP, cropped: false };
};

// Top to bottom, the frame's width is the one thing a row of cards cannot grow past, and shrinking the run to fit it
// shrinks every name with it. So a stage wider than the frame wraps instead: onto as few lines as fit, split where its
// longest line comes out shortest (seven like cards are four and three, never six and one), in its own order, so it
// reads left to right and down. Each card's line, 0 first; every card on line 0 when the stage fits.
// One way to split a stage: how many cards each line takes, and how wide the longest line comes out.
interface Wrap {
    readonly longest: number;
    readonly sizes: readonly number[];
}

export const wrapLines = (widths: readonly number[], maxSpan: number, gap: number): number[] => {
    const count = widths.length;
    const span = (from: number, to: number): number => widths.slice(from, to).reduce((sum, width) => sum + width, 0) + Math.max(0, to - from - 1) * gap;
    // The cards from `from` on, split into `lines` lines so the longest is as short as it can be.
    const known = new Map<string, Wrap>();
    const split = (from: number, lines: number): Wrap => {
        if (lines === 1) {
            return { longest: span(from, count), sizes: [count - from] };
        }
        const key = `${from}/${lines}`;
        const remembered = known.get(key);
        if (remembered !== undefined) {
            return remembered;
        }
        let best: Wrap = { longest: Number.POSITIVE_INFINITY, sizes: [] };
        // The fullest first line is tried first, so of two splits as good, the shorter line is the later one.
        for (let size = count - from - (lines - 1); size >= 1; size -= 1) {
            const rest = split(from + size, lines - 1);
            const longest = Math.max(span(from, from + size), rest.longest);
            if (longest < best.longest) {
                best = { longest, sizes: [size, ...rest.sizes] };
            }
        }
        known.set(key, best);
        return best;
    };
    for (let lines = 1; lines <= count; lines += 1) {
        const { longest, sizes } = split(0, lines);
        if (longest <= maxSpan || lines === count) {
            return sizes.flatMap((size, line) => Array.from({ length: size }, () => line));
        }
    }
    return [];
};
