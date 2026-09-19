import { describe, expect, it } from "vitest";
import { scrollToShow, uniformRows, variableRows, windowOf } from "./rowWindow";

describe(`uniformRows`, () => {
    const rows = uniformRows(1000, 22);

    it(`measures the whole list, not the rendered part`, () => {
        expect(rows.total).toBe(22_000);
    });

    it(`places a row by multiplication, and reads one back by division`, () => {
        expect(rows.offsetOf(10)).toBe(220);
        expect(rows.indexAt(229)).toBe(10);
        expect(rows.indexAt(230)).toBe(10);
        expect(rows.indexAt(231)).toBe(10);
    });

    it(`defines the end offset, so a half-open range has a bottom`, () => {
        expect(rows.offsetOf(1000)).toBe(rows.total);
    });

    it(`clamps a point past the end onto the last row`, () => {
        expect(rows.indexAt(9_999_999)).toBe(999);
    });

    it(`answers 0 for an empty list rather than -1`, () => {
        const none = uniformRows(0, 22);
        expect(none.total).toBe(0);
        expect(none.indexAt(0)).toBe(0);
    });
});

describe(`variableRows`, () => {
    // A desk-shaped list: a label, two tile rows, a label, one tile row.
    const rows = variableRows([30, 100, 100, 30, 100]);

    it(`sums the heights it was given`, () => {
        expect(rows.total).toBe(360);
        expect(rows.offsetOf(0)).toBe(0);
        expect(rows.offsetOf(1)).toBe(30);
        expect(rows.offsetOf(3)).toBe(230);
        expect(rows.offsetOf(5)).toBe(360);
    });

    it(`finds the band a scroll offset lands in`, () => {
        expect(rows.indexAt(0)).toBe(0);
        expect(rows.indexAt(29)).toBe(0);
        expect(rows.indexAt(30)).toBe(1);
        expect(rows.indexAt(229)).toBe(2);
        expect(rows.indexAt(230)).toBe(3);
        expect(rows.indexAt(359)).toBe(4);
    });

    it(`agrees with uniformRows where every row is the same height`, () => {
        const varied = variableRows(Array.from({ length: 50 }, () => 22));
        const flat = uniformRows(50, 22);
        expect(varied.total).toBe(flat.total);
        for (const at of [0, 1, 17, 49]) {
            expect(varied.offsetOf(at)).toBe(flat.offsetOf(at));
            expect(varied.indexAt(at * 22 + 5)).toBe(flat.indexAt(at * 22 + 5));
        }
    });
});

describe(`windowOf`, () => {
    const rows = uniformRows(10_000, 22);

    it(`renders the crossing slice and its overscan, not the list`, () => {
        // 800px of viewport is ~37 rows; the slice stays a constant size however long the list is.
        const { first, last } = windowOf(rows, 22_000, 800, 8);
        expect(first).toBe(992);
        expect(last).toBe(1045);
        expect(last - first).toBeLessThan(60);
    });

    it(`does not run off either end`, () => {
        expect(windowOf(rows, 0, 800, 8).first).toBe(0);
        expect(windowOf(rows, rows.total, 800, 8).last).toBe(10_000);
    });

    it(`renders nothing for an empty list`, () => {
        expect(windowOf(uniformRows(0, 22), 0, 800, 8)).toEqual({ first: 0, last: 0 });
    });

    it(`still renders a row before the viewport has been measured`, () => {
        expect(windowOf(rows, 0, 0, 8).last).toBeGreaterThan(0);
    });
});

describe(`scrollToShow`, () => {
    const rows = uniformRows(1000, 22);

    it(`leaves a row that already fits where it is`, () => {
        expect(scrollToShow(rows, 10, 200, 400)).toBe(200);
    });

    it(`scrolls up just far enough to reach a row above`, () => {
        expect(scrollToShow(rows, 2, 200, 400)).toBe(44);
    });

    it(`scrolls down just far enough to reach a row below`, () => {
        // Row 30 ends at 682; a 400px viewport must start at 282 to show it.
        expect(scrollToShow(rows, 30, 100, 400)).toBe(282);
    });

    it(`shows the start of a row taller than the viewport, not its end`, () => {
        const tall = variableRows([1000]);
        expect(scrollToShow(tall, 0, 0, 400)).toBe(0);
    });
});
