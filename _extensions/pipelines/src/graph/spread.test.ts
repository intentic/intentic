import { GUTTER_PX, LEGIBLE_FIT, RANK_SEP_MAX, RANK_SEP_MIN, READABLE_ZOOM, spreadColumns } from "./spread";

// Pins that the frame's width goes to gutters rather than margins: a long run keeps its gutters readable on screen and
// is otherwise as large as fits, a short one spreads out up to a bound, and a run too long to read whole is cropped.

const frame = { frameWidth: 1700, frameHeight: 600 };

describe(`spreadColumns`, () => {
    test(`a long run fits the width with every gutter GUTTER_PX wide on screen`, () => {
        const spread = spreadColumns({ ...frame, cardsWidth: 1500, columns: 12, contentHeight: 300 });
        expect(spread.zoom).toBeCloseTo((1700 - 11 * GUTTER_PX) / 1500);
        expect(spread.rankSep * spread.zoom).toBeGreaterThanOrEqual(GUTTER_PX - 4);
        expect(1500 * spread.zoom + 11 * spread.rankSep * spread.zoom).toBeLessThanOrEqual(1700);
        expect(spread.cropped).toBe(false);
    });

    test(`a short run stays at full size and widens its gutters into the room left, up to a bound`, () => {
        const four = spreadColumns({ ...frame, cardsWidth: 480, columns: 4, contentHeight: 200 });
        expect(four.zoom).toBe(1);
        expect(four.rankSep).toBe(RANK_SEP_MAX);
        const eight = spreadColumns({ ...frame, cardsWidth: 1000, columns: 8, contentHeight: 200 });
        expect(eight.rankSep).toBe(Math.floor((1700 - 1000) / 7 / 4) * 4);
    });

    test(`a run bound by height leaves its gutters to fill the width instead`, () => {
        const spread = spreadColumns({ ...frame, cardsWidth: 1200, columns: 10, contentHeight: 1000 });
        expect(spread.zoom).toBeCloseTo(0.6);
        expect(spread.rankSep).toBeGreaterThan(RANK_SEP_MIN);
        expect(1200 * spread.zoom + 9 * spread.rankSep * spread.zoom).toBeLessThanOrEqual(1700);
    });

    test(`a run too long to read whole is shown cropped at the readable zoom`, () => {
        const spread = spreadColumns({ ...frame, cardsWidth: 6000, columns: 40, contentHeight: 300 });
        expect(spread).toEqual({ zoom: READABLE_ZOOM, rankSep: Math.ceil(GUTTER_PX / READABLE_ZOOM), cropped: true });
        expect(LEGIBLE_FIT).toBeLessThan(READABLE_ZOOM);
    });
});
