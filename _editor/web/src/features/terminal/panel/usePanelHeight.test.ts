import "@intentic/testing/dom";
import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_HEIGHT, MIN_HEIGHT, usePanelHeight } from "./usePanelHeight";

// Pins the panel's height: the default until one is remembered, a remembered one clamped to the floor and to 80% of
// the viewport, and what the seam drags clamped the same way and remembered per surface.

afterEach(() => {
    localStorage.clear();
});

describe(`the panel's height`, () => {
    it(`starts at the default until one is remembered`, () => {
        expect([DEFAULT_HEIGHT, MIN_HEIGHT]).toEqual([240, 96]);
        expect(usePanelHeight(`dock`).height.value).toBe(DEFAULT_HEIGHT);
    });

    it(`reads a remembered height back, clamped to the floor and the viewport's share`, () => {
        localStorage.setItem(`ui-dock-terminal-height`, `40`);
        expect(usePanelHeight(`dock`).height.value).toBe(MIN_HEIGHT);
        localStorage.setItem(`ui-dock-terminal-height`, String(window.innerHeight * 2));
        expect(usePanelHeight(`dock`).height.value).toBe(Math.round(window.innerHeight * 0.8));
    });

    it(`remembers what the seam drags, per surface`, () => {
        const panel = usePanelHeight(`dock`);
        panel.seamHeight.value = 300.4;
        expect([panel.height.value, localStorage.getItem(`ui-dock-terminal-height`), localStorage.getItem(`ui-float-terminal-height`)]).toEqual([
            300,
            `300`,
            null,
        ]);
        expect(panel.maxHeight.value).toBe(Math.round(window.innerHeight * 0.8));
    });
});
