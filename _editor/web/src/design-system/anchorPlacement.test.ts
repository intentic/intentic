// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { placeAnchored } from "@intentic/ui";

// @intentic/ui reaches window.matchMedia at import; jsdom plus vitest.setup.ts's stub cover it.

// Geometry behind every anchored panel (composer pickers, tab strip history), lives in @intentic/ui (no
// test runner), pinned here. Tests that placement uses the given `view`, not a module-scope window, since the app draws
// into iframes.

// The composer's pill: near the bottom edge of whatever window it is in, panel opening upward.
const pill = { top: 727, left: 10, width: 140, height: 36 };
const picker = { width: 418, height: 430 };
const base = { anchor: pill, box: picker, side: `top`, cross: `start`, gap: 8, edge: 8 } as const;

describe(`placeAnchored`, () => {
    it(`measures the room in the view it was GIVEN, not in some other window`, () => {
        // The floating window the pill is actually in: 800 tall, so the whole picker fits above it.
        const inPopout = placeAnchored({ ...base, view: { width: 1280, height: 800 } });
        expect(inPopout.side).toBe(`top`);
        expect(inPopout.top).toBe(727 - 8 - 430);
        expect(inPopout.maxHeight).toBe(727 - 8 - 8);

        // The same pill riding the bottom of a 380-tall window; capped to the room above rather than flipped below.
        const short = placeAnchored({ ...base, anchor: { ...pill, top: 307 }, view: { width: 1280, height: 380 } });
        expect(short.side).toBe(`top`);
        expect(short.maxHeight).toBe(307 - 8 - 8);
    });

    it(`never lands the panel on top of the pill that opens it`, () => {
        for (const height of [200, 430, 900]) {
            for (const viewHeight of [380, 800, 1200]) {
                const anchor = { ...pill, top: viewHeight - 73 };
                const placement = placeAnchored({ ...base, anchor, box: { ...picker, height }, view: { width: 1280, height: viewHeight } });
                const boxHeight = Math.min(height, placement.maxHeight);
                const overlaps = placement.top < anchor.top + anchor.height && placement.top + boxHeight > anchor.top;
                expect(overlaps, `h=${height} view=${viewHeight}`).toBe(false);
                // …and stays inside the window, which is the other half of being clickable.
                expect(placement.top, `h=${height} view=${viewHeight}`).toBeGreaterThanOrEqual(0);
                expect(placement.top + boxHeight, `h=${height} view=${viewHeight}`).toBeLessThanOrEqual(viewHeight);
            }
        }
    });

    it(`flips to the side with more room, and only then`, () => {
        // A trigger at the top of the window: nothing fits above it, plenty below.
        const top = placeAnchored({ ...base, anchor: { ...pill, top: 40 }, view: { width: 1280, height: 800 } });
        expect(top.side).toBe(`bottom`);
        expect(top.top).toBe(40 + 36 + 8);

        // A trigger with the box fitting above stays above even though below has more room: it must not jump sides.
        const fits = placeAnchored({ ...base, box: { width: 418, height: 120 }, anchor: { ...pill, top: 200 }, view: { width: 1280, height: 800 } });
        expect(fits.side).toBe(`top`);
    });

    it(`aligns across the anchor and pulls the box inside the window`, () => {
        const view = { width: 1280, height: 800 };
        expect(placeAnchored({ ...base, view }).left).toBe(10); // start: the pill's own left edge
        // End-aligned, the panel would start off-screen at -268; clamped to the viewport margin instead.
        expect(placeAnchored({ ...base, view, cross: `end` }).left).toBe(8);

        // The mode pill sits hard against the right edge; an end-aligned panel hangs inward, needing no clamping.
        const rightPill = { top: 727, left: 1200, width: 67, height: 36 };
        const mode = placeAnchored({ ...base, anchor: rightPill, box: { width: 224, height: 200 }, view, cross: `end` });
        expect(mode.left).toBe(1200 + 67 - 224);
        expect(mode.left + 224).toBeLessThanOrEqual(view.width - 8);
    });

    it(`points the arrow at the anchor's centre even when the box was pushed sideways`, () => {
        const view = { width: 1280, height: 800 };
        // Room on both sides: the box centres on the pill and the arrow sits at its middle.
        const centred = placeAnchored({ ...base, anchor: { ...pill, left: 500 }, view, cross: `center` });
        expect(centred.arrow).toBeCloseTo(picker.width / 2, 5);

        // A pill against the left edge pulls the box inward: the box moves, the arrow stays over the pill.
        const edgePill = { top: 727, left: 0, width: 40, height: 36 };
        const pushed = placeAnchored({ ...base, anchor: edgePill, view, cross: `center` });
        expect(pushed.left).toBe(8);
        expect(pushed.arrow).toBe(20 - 8);
    });
});
