// @vitest-environment jsdom
//
// jsdom because the whole subject is what the composable does to the DOCUMENT: the attribute every rule in
// hud.css hangs off, and the webfont <link> that must not be there when no skin is on.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Eight `await import()` calls, one per test, because the subject is a module-scope singleton that reads
// storage and the document as it evaluates: `vi.resetModules()` plus a fresh import IS the reset. That only
// stays cheap because `useSkin` reaches `useTheme` through @intentic/ui/theme rather than the design system's
// barrel; off the barrel each of these re-entered the component graph inside a test body, on the same clock as
// the assertions, and lost the 20s budget to a busy machine.

const load = () => import("./useSkin");
const root = () => document.documentElement;
const fontLink = () => document.getElementById(`ui-skin-font`);

beforeEach(() => {
    localStorage.clear();
    root().removeAttribute(`data-skin`);
    root().removeAttribute(`data-mode`);
    fontLink()?.remove();
    vi.resetModules();
});

describe(`useSkin`, () => {
    it(`defaults to sanctum, attribute and webfont together`, async () => {
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`sanctum`);
        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
        expect(fontLink()).not.toBeNull();
    });

    it(`restores a stored skin on load, attribute and webfont together`, async () => {
        localStorage.setItem(`ui-skin`, `hud`);
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`hud`);
        expect(root().getAttribute(`data-skin`)).toBe(`hud`);
        expect(fontLink()).not.toBeNull();
    });

    it(`restores the other skin just as well`, async () => {
        localStorage.setItem(`ui-skin`, `sanctum`);
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`sanctum`);
        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });

    it(`ignores a stored value that is not a skin`, async () => {
        localStorage.setItem(`ui-skin`, `neon`);
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`sanctum`);
        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });

    it(`turns the HUD on: attribute, storage, webfont, and the dark scheme it is built for`, async () => {
        const { useSkin } = await load();

        useSkin().setSkin(`hud`);

        expect(root().getAttribute(`data-skin`)).toBe(`hud`);
        expect(root().getAttribute(`data-mode`)).toBe(`dark`);
        expect(localStorage.getItem(`ui-skin`)).toBe(`hud`);
        expect(fontLink()).not.toBeNull();
    });

    // The detach, asserted: leaving the skin has to leave NOTHING, no attribute for a rule to match, no font
    // being paid for. Anything left behind here is the app not actually coming back to normal.
    it(`turns it off completely: no attribute left, no webfont left`, async () => {
        localStorage.setItem(`ui-skin`, `hud`);
        const { useSkin } = await load();

        useSkin().setSkin(`none`);

        expect(root().hasAttribute(`data-skin`)).toBe(false);
        expect(localStorage.getItem(`ui-skin`)).toBe(`none`);
        expect(fontLink()).toBeNull();
    });

    it(`asks for the webfont once, however many times a skin is applied`, async () => {
        const { useSkin } = await load();

        useSkin().setSkin(`hud`);
        useSkin().setSkin(`hud`);

        expect(document.querySelectorAll(`#ui-skin-font`)).toHaveLength(1);
    });

    // Each skin has a face of its own, and swapping between them must RE-POINT the one <link> rather than stack
    // a second one behind it, which is the bug the id and the re-point in applyFont exist to prevent.
    it(`swaps one webfont for the other when the skin changes`, async () => {
        const { useSkin } = await load();

        useSkin().setSkin(`hud`);
        const first = (fontLink() as HTMLLinkElement).href;
        useSkin().setSkin(`sanctum`);
        const second = (fontLink() as HTMLLinkElement).href;

        expect(document.querySelectorAll(`#ui-skin-font`)).toHaveLength(1);
        expect(first).toContain(`Chakra+Petch`);
        expect(second).toContain(`Baloo+2`);
    });
});
