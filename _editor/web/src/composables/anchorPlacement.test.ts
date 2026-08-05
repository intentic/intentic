// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { placeAnchored } from "@intentic/ui";

// The barrel reaches window.matchMedia (useDevice) at import — hence jsdom plus the stub jsdom itself doesn't
// ship. The geometry under test is pure arithmetic and touches no DOM.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
});

/* The geometry behind every anchored panel in a POPPABLE panel (the composer's model/mode pickers, the tab
 * strip's history menu). It lives in @intentic/ui, which carries no test runner of its own — so it is
 * pinned here, where the surfaces that broke without it live.
 *
 * WHAT THESE PIN IS A BUG THAT CAME BACK TWICE. PrimeVue's Popover measures the room around a trigger with the
 * module-scope `window`, which for a popped-out chat panel is the OPENER's window while the overlay lands in
 * the pop-out's. When the two differ — and they always do; one is a column, the other a window the user
 * dragged — it decided "no room above, flip below" against the wrong numbers and put the picker off the bottom
 * edge with its top over the very pill that opens it. An overlay covering its own trigger cannot be closed by
 * clicking that trigger, and that is what "sometimes I can't close the model picker" was. Hence: the view is an
 * argument, and these tests are about what the answer does with it. */

// The composer's pill: near the bottom edge of whatever window it is in, panel opening upward.
const pill = { top: 727, left: 10, width: 140, height: 36 };
const picker = { width: 418, height: 430 };
const base = { anchor: pill, box: picker, side: `top`, cross: `start`, gap: 8, edge: 8 } as const;

describe(`placeAnchored`, () => {
    it(`measures the room in the view it was GIVEN, not in some other window`, () => {
        // The pop-out window the pill is actually in: 800 tall, so the whole picker fits above it.
        const inPopout = placeAnchored({ ...base, view: { width: 1280, height: 800 } });
        expect(inPopout.side).toBe(`top`);
        expect(inPopout.top).toBe(727 - 8 - 430);
        expect(inPopout.maxHeight).toBe(727 - 8 - 8);

        // The same pill, riding the bottom of a window 380 tall — a chat column, or a pop-out the user made
        // short. The panel is CAPPED to the room above rather than flipped below, where 21px is all there is.
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

        // A trigger with the box fitting above stays above even though below has more room — a panel that
        // already fits must not jump sides.
        const fits = placeAnchored({ ...base, box: { width: 418, height: 120 }, anchor: { ...pill, top: 200 }, view: { width: 1280, height: 800 } });
        expect(fits.side).toBe(`top`);
    });

    it(`aligns across the anchor and pulls the box inside the window`, () => {
        const view = { width: 1280, height: 800 };
        expect(placeAnchored({ ...base, view }).left).toBe(10); // start: the pill's own left edge
        // End-aligned against a pill 10px from the left edge, the panel would start at -268: clamped to the
        // viewport margin instead, because a panel half off the window is one the user cannot read or click.
        expect(placeAnchored({ ...base, view, cross: `end` }).left).toBe(8);

        // The mode pill sits hard against the right edge; an end-aligned panel hangs off its right edge inward
        // and needs no clamping.
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

        // A pill against the left edge pulls the box inward — the box moved, the arrow stays over the pill.
        const edgePill = { top: 727, left: 0, width: 40, height: 36 };
        const pushed = placeAnchored({ ...base, anchor: edgePill, view, cross: `center` });
        expect(pushed.left).toBe(8);
        expect(pushed.arrow).toBe(20 - 8);
    });
});
