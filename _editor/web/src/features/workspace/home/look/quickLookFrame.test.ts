// The quick look stands where it is largest, plainly larger than its tile, and never past the window's edge.
import { lookFrame, mediaCard, type MediaLimits, type Size } from "./quickLookFrame";

const VIEW = { width: 1600, height: 1000 };
const GAP = 12;
const EDGE = 8;

// A wide screenshot's card: no cap of its own but the room, a 55px header and a border either side.
const LIMITS: MediaLimits = { cap: { width: 1280, height: 10_000 }, chrome: { width: 2, height: 55 }, minWidth: 256 };
const screenshot = (room: Size): Size => mediaCard(room, 16 / 9, LIMITS);

const inside = (frame: { left: number; top: number; width: number; height: number }): boolean =>
    frame.left >= EDGE && frame.top >= EDGE && frame.left + frame.width <= VIEW.width - EDGE && frame.top + frame.height <= VIEW.height - EDGE;

describe(`mediaCard`, () => {
    it(`draws the picture as large as the room lets it keep its shape, under its header`, () => {
        const card = mediaCard({ width: 802, height: 2000 }, 2, LIMITS);
        expect(card.media).toEqual({ width: 800, height: 400 });
        expect(card).toMatchObject({ width: 802, height: 455 });
    });

    it(`never blows a picture up past its own pixels, and keeps the header readable over a thin one`, () => {
        const card = mediaCard({ width: 1500, height: 900 }, 1, { ...LIMITS, own: { width: 64, height: 64 } });
        expect(card.media).toEqual({ width: 64, height: 64 });
        expect(card.width).toBe(256);
    });

    it(`answers a sensible shape for a picture whose shape is not known yet`, () => {
        expect(mediaCard({ width: 802, height: 2000 }, Number.NaN, LIMITS).media).toEqual({ width: 800, height: 500 });
    });
});

describe(`lookFrame`, () => {
    it(`stands beside a gallery tile on its roomier side, centred on it, and larger than it`, () => {
        const anchor = { left: 40, top: 300, width: 430, height: 270 };
        const frame = lookFrame({ anchor, view: VIEW, gap: GAP, edge: EDGE, size: screenshot });
        expect(frame.side).toBe(`right`);
        expect(frame.left).toBe(anchor.left + anchor.width + GAP);
        expect(frame.width).toBeGreaterThan(anchor.width * 1.5);
        expect(frame.top + frame.height / 2).toBeCloseTo(anchor.top + anchor.height / 2, 0);
        expect(inside(frame)).toBe(true);
    });

    it(`takes the left where the tile is at the right of the window`, () => {
        const anchor = { left: 1100, top: 300, width: 430, height: 270 };
        const frame = lookFrame({ anchor, view: VIEW, gap: GAP, edge: EDGE, size: screenshot });
        expect(frame.side).toBe(`left`);
        expect(frame.left + frame.width).toBe(anchor.left - GAP);
        expect(inside(frame)).toBe(true);
    });

    it(`lays the card over a tile with no side worth standing on, inside the window`, () => {
        // A large tile in the middle: neither side nor above nor below has room for a card half as large again.
        const anchor = { left: 500, top: 250, width: 600, height: 500 };
        const frame = lookFrame({ anchor, view: VIEW, gap: GAP, edge: EDGE, size: screenshot });
        expect(frame.side).toBe(`over`);
        expect(frame.width).toBeGreaterThan(anchor.width * 1.5);
        expect(inside(frame)).toBe(true);
    });

    it(`stays inside the window by the bottom edge, wherever its tile is`, () => {
        const anchor = { left: 40, top: 900, width: 200, height: 90 };
        const frame = lookFrame({ anchor, view: VIEW, gap: GAP, edge: EDGE, size: screenshot });
        expect(inside(frame)).toBe(true);
    });

    it(`puts a small fixed card to the right of a grid tile, aligned on its middle`, () => {
        const anchor = { left: 100, top: 100, width: 110, height: 120 };
        const card = (room: Size): Size => ({ width: Math.min(576, room.width), height: Math.min(300, room.height) });
        expect(lookFrame({ anchor, view: VIEW, gap: GAP, edge: EDGE, size: card })).toEqual({
            side: `right`,
            width: 576,
            height: 300,
            left: 222,
            // Its middle on the tile's: 160 less half of 300.
            top: 10,
        });
    });

    it(`keeps a small picture beside its tile rather than over it, being no larger there`, () => {
        const anchor = { left: 600, top: 300, width: 400, height: 300 };
        const icon = (room: Size): Size => mediaCard(room, 1, { ...LIMITS, own: { width: 300, height: 300 } });
        expect(lookFrame({ anchor, view: VIEW, gap: GAP, edge: EDGE, size: icon }).side).toBe(`right`);
    });
});
