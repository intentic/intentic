import { describe, expect, test } from "vitest";
import { MIN_VIEWPORT, regionOf, regionsEqual, windowBoundsFor, type WindowGeometry } from "./region.js";

// The grab region is arithmetic over what the page reports; wrong arithmetic is a picture of the toolbar, or a click
// that lands 87 px above where it was aimed, neither of which errors.

const SCREEN = { width: 2560, height: 1600 };

// What Chromium reports for a 1280×880 window at the screen's bottom-right corner; the toolbar measures 87 CSS px
// (docs/design/browser-surface-analysis.md, §6).
const geometry = (over: Partial<WindowGeometry> = {}): WindowGeometry => ({
    screenX: 1280,
    screenY: 720,
    outerWidth: 1280,
    outerHeight: 880,
    innerWidth: 1280,
    innerHeight: 793,
    dpr: 1,
    ...over,
});

describe("regionOf", () => {
    test("the region is the viewport below the toolbar, in the display's pixels", () => {
        expect(regionOf(geometry(), SCREEN)).toEqual({ x: 1280, y: 807, width: 1280, height: 792, scale: 1 });
    });

    test("a scale factor multiplies every edge, so a 2× display grabs twice the pixels", () => {
        // A window that fits the screen at 2×: 1280×787 CSS px is 2560×1574 device px.
        expect(regionOf(geometry({ screenX: 0, screenY: 0, dpr: 2, outerHeight: 787, innerHeight: 700 }), SCREEN)).toEqual({
            x: 0,
            y: 174,
            width: 2560,
            height: 1400,
            scale: 2,
        });
    });

    test("a window hanging off the screen is clamped to the pixels that exist", () => {
        expect(regionOf(geometry({ screenX: 2000 }), SCREEN)).toMatchObject({ x: 2000, width: 560 });
        expect(regionOf(geometry({ screenY: 1500 }), SCREEN)).toMatchObject({ y: 1587, height: 12 });
    });

    test("odd sizes lose a pixel, since the encoder refuses them", () => {
        expect(regionOf(geometry({ innerWidth: 1279, innerHeight: 793 }), SCREEN)).toMatchObject({ width: 1278, height: 792 });
    });

    test("a scale that is zero or not a number reads as one", () => {
        expect(regionOf(geometry({ dpr: 0 }), SCREEN).scale).toBe(1);
        expect(regionOf(geometry({ dpr: Number.NaN }), SCREEN).scale).toBe(1);
    });
});

test("regions compare by every field", () => {
    const one = regionOf(geometry(), SCREEN);
    expect(regionsEqual(one, { ...one })).toBe(true);
    expect(regionsEqual(one, { ...one, y: one.y + 1 })).toBe(false);
    expect(regionsEqual(one, { ...one, scale: 2 })).toBe(false);
});

describe("windowBoundsFor", () => {
    test("the window is the viewport plus the chrome, anchored to the screen's bottom-right corner", () => {
        expect(windowBoundsFor({ width: 1000, height: 600 }, geometry(), SCREEN)).toEqual({ left: 1560, top: 913, width: 1000, height: 687 });
    });

    test("a viewport larger than the screen is capped at it, and lands at the origin", () => {
        expect(windowBoundsFor({ width: 5000, height: 5000 }, geometry(), SCREEN)).toEqual({ left: 0, top: 0, width: 2560, height: 1600 });
    });

    test("narrower than a phone is never asked for", () => {
        expect(windowBoundsFor({ width: 100, height: 100 }, geometry(), SCREEN)).toMatchObject({ width: MIN_VIEWPORT, height: MIN_VIEWPORT + 87 });
    });

    test("at 2× the screen holds half as many CSS pixels", () => {
        expect(windowBoundsFor({ width: 5000, height: 5000 }, geometry({ dpr: 2 }), SCREEN)).toEqual({ left: 0, top: 0, width: 1280, height: 800 });
    });

    test("fractional sizes from a layout are rounded, not truncated", () => {
        expect(windowBoundsFor({ width: 999.6, height: 600.4 }, geometry(), SCREEN)).toMatchObject({ width: 1000, height: 687 });
    });
});
