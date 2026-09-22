import "@intentic/testing/dom";
import { describe, it, expect, beforeEach } from "bun:test";
import { useTextSize } from "@intentic/ui/text-size";
import { toAppPx, toScreenPx, uiLength } from "./uiScale";

/* The trip between the two units. */

// uiScale reads the same text-size singleton this file writes, so both must be the one module instance: every case
// sets the size it asserts against rather than re-evaluating the module.
beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute(`data-text-size`);
});

describe(`uiScale`, () => {
    it(`hands CSS the arithmetic rather than a number, so a column follows a size change on its own`, () => {
        expect(uiLength(352)).toBe(`calc(352px * var(--ui-scale))`);
    });

    it(`converts a pointer position into the unit widths are stored in`, () => {
        useTextSize().setTextSize(`default`);

        // Comfortable (110%): a drag to 387 screen pixels is the 352 the column was measured at.
        expect(toAppPx(387.2)).toBeCloseTo(352);
    });

    it(`survives the round trip at every size`, () => {
        for (const size of [`compact`, `default`, `large`] as const) {
            useTextSize().setTextSize(size);
            expect(toScreenPx(toAppPx(440))).toBe(440);
        }
    });

    it(`grows the editors' type with the app, so code never reads smaller than the panel beside it`, () => {
        useTextSize().setTextSize(`compact`);
        expect(toScreenPx(13)).toBe(13);
        useTextSize().setTextSize(`default`);
        expect(toScreenPx(13)).toBe(14);
        useTextSize().setTextSize(`large`);
        expect(toScreenPx(13)).toBe(16);
    });
});
