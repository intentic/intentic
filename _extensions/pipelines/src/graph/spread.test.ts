import { GUTTER_PX, RANK_SEP_MAX, RANK_SEP_MIN, READABLE_ZOOM, ROW_GAP, spreadColumns, spreadRows, wrapLines } from "./spread";

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
    });
});

// Top to bottom, the run is read down the page: only its widest row decides the zoom, never its height.
describe(`spreadRows`, () => {
    test(`a run whose rows fit is drawn at full size, however tall`, () => {
        expect(spreadRows({ contentWidth: 900, frameWidth: 1700 })).toEqual({ zoom: 1, rankSep: ROW_GAP, cropped: false });
    });

    test(`a row wider than the frame shrinks the run to fit it`, () => {
        const spread = spreadRows({ contentWidth: 2000, frameWidth: 1600 });
        expect(spread.zoom).toBeCloseTo(0.8);
        expect(spread.cropped).toBe(false);
    });

    test(`a row too wide to read whole is shown from its start at a readable size instead`, () => {
        expect(spreadRows({ contentWidth: 3000, frameWidth: 600 })).toEqual({ zoom: READABLE_ZOOM, rankSep: ROW_GAP, cropped: true });
    });
});

// A stage wider than the frame wraps rather than shrinking every name: onto as few lines as fit, as evenly as its cards
// divide, in its own order.
describe(`wrapLines`, () => {
    test(`keeps a stage that fits on one line`, () => {
        expect(wrapLines([100, 100, 100], 400, 24)).toEqual([0, 0, 0]);
    });

    test(`wraps onto as few lines as fit, the longer line first`, () => {
        // Seven 100px cards in a 500px frame: four a line is 472px, so two lines, four then three.
        expect(wrapLines(Array.from({ length: 7 }, () => 100), 500, 24)).toEqual([0, 0, 0, 0, 1, 1, 1]);
    });

    test(`splits evenly rather than filling the first line and leaving one card on the last`, () => {
        // Five fit on a 600px line; six do not. Six cards are three and three, not five and one.
        expect(wrapLines(Array.from({ length: 6 }, () => 96), 600, 24)).toEqual([0, 0, 0, 1, 1, 1]);
    });

    test(`splits by width, not by count, so two wide cards never share the line that cannot hold them`, () => {
        // Two lines cannot fit 450px either way; three can: each wide card alone, the two narrow ones together.
        expect(wrapLines([300, 300, 100, 100], 450, 24)).toEqual([0, 1, 2, 2]);
    });

    test(`puts a card wider than the frame on a line of its own`, () => {
        expect(wrapLines([900, 100], 500, 24)).toEqual([0, 1]);
    });
});
