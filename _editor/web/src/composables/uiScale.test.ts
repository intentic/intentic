// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/* The trip between the two units. What this really guards is the round trip: a reader drags a column to some
 * position on screen, and what comes back out on the next paint has to be that same position: at every text
 * size, or a column would creep every time it was touched. */

const load = async () => ({ ...(await import("./uiScale")), ...(await import("@intentic/ui/text-size")) });

beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute(`data-text-size`);
    vi.resetModules();
});

describe(`uiScale`, () => {
    it(`hands CSS the arithmetic rather than a number, so a column follows a size change on its own`, async () => {
        const { uiLength } = await load();

        expect(uiLength(352)).toBe(`calc(352px * var(--ui-scale))`);
    });

    it(`converts a pointer position into the unit widths are stored in`, async () => {
        const { toAppPx } = await load();

        // Default size: a drag to 387 screen pixels is the 352 the column was measured at.
        expect(toAppPx(387.2)).toBeCloseTo(352);
    });

    it(`survives the round trip at every size`, async () => {
        const { toAppPx, toScreenPx, useTextSize } = await load();

        for (const size of [`compact`, `default`, `large`] as const) {
            useTextSize().setTextSize(size);
            expect(toScreenPx(toAppPx(440))).toBe(440);
        }
    });

    it(`grows the editors' type with the app, so code never reads smaller than the panel beside it`, async () => {
        const { toScreenPx, useTextSize } = await load();

        useTextSize().setTextSize(`compact`);
        expect(toScreenPx(13)).toBe(13);
        useTextSize().setTextSize(`default`);
        expect(toScreenPx(13)).toBe(14);
        useTextSize().setTextSize(`large`);
        expect(toScreenPx(13)).toBe(16);
    });
});
