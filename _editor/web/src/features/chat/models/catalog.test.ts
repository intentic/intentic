import { describe, expect, it } from "vitest";
import { statusIcon, statusTabClass } from "./catalog";

/* The tab strip's two projections of one conversation's status, checked against the rule that decides how many
 * of them are allowed to move: the glyph carries the motion, the title carries the colour. Both are drawn side
 * by side in the same 7px-tall button, for as long as a turn runs, which on a long turn is minutes. */
describe(`statusTabClass`, () => {
    it(`colours the title without animating it: the spinner beside it already says "running"`, () => {
        expect(statusIcon(`streaming`).spin).toBe(true);
        expect(statusTabClass(`streaming`)).toBe(`text-link`);
    });

    it(`never animates in any state`, () => {
        for (const status of [`streaming`, `awaiting`, `error`, `idle`] as const) {
            expect(statusTabClass(status)).not.toMatch(/\banimate-/);
        }
    });

    it(`gives each state its own colour, so the glyph is never the only difference`, () => {
        expect(statusTabClass(`awaiting`)).toBe(`text-primary-500`);
        expect(statusTabClass(`error`)).toBe(`text-danger`);
        expect(statusTabClass(`idle`)).toBe(``);
    });
});
