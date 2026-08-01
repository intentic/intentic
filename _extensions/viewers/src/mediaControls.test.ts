import { describe, expect, it } from "vitest";
import { formatDuration, seekTargets, SPEEDS } from "./mediaControls";

describe(`formatDuration`, () => {
    it(`drops the hours field below an hour`, () => {
        expect(formatDuration(0)).toBe(`0:00`);
        expect(formatDuration(9)).toBe(`0:09`);
        expect(formatDuration(95)).toBe(`1:35`);
        expect(formatDuration(3599)).toBe(`59:59`);
    });

    it(`adds hours once there are any, and pads the fields under them`, () => {
        expect(formatDuration(3600)).toBe(`1:00:00`);
        expect(formatDuration(3661)).toBe(`1:01:01`);
        expect(formatDuration(36061)).toBe(`10:01:01`);
    });

    it(`truncates rather than rounds, so the clock never shows a second the file hasn't reached`, () => {
        expect(formatDuration(59.9)).toBe(`0:59`);
    });

    /* A container that never declared its duration (a .webm with no cues) reads back Infinity, and a media
     * element reports NaN before metadata lands. Rendering either as "0:00" would claim the file is empty. */
    it(`shows a dash for a duration the container never declared`, () => {
        expect(formatDuration(Number.POSITIVE_INFINITY)).toBe(`--:--`);
        expect(formatDuration(Number.NaN)).toBe(`--:--`);
        expect(formatDuration(-1)).toBe(`--:--`);
    });
});

describe(`the transport's shared tables`, () => {
    it(`pairs every seek key with its opposite`, () => {
        expect(seekTargets[`ArrowLeft`]).toBe(-seekTargets[`ArrowRight`]!);
        expect(seekTargets[`j`]).toBe(-seekTargets[`l`]!);
        // Shift-held variants resolve the same way rather than falling through to nothing.
        expect(seekTargets[`J`]).toBe(seekTargets[`j`]);
        expect(seekTargets[`L`]).toBe(seekTargets[`l`]);
    });

    // The `,`/`.` shortcuts step through this array by index, so an unsorted or duplicated ladder would make
    // "one step slower" jump or stall.
    it(`keeps the speed ladder sorted, unique, and centred on 1×`, () => {
        expect(SPEEDS).toEqual(SPEEDS.toSorted((a, b) => a - b));
        expect(new Set(SPEEDS).size).toBe(SPEEDS.length);
        expect(SPEEDS).toContain(1);
    });
});
