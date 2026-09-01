// @vitest-environment jsdom
//
// jsdom because the whole subject is what the composable does to the DOCUMENT: the attribute every rule in
// sanctum.css hangs off, and the webfont <link> that must not be there when no skin is on.
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
        localStorage.setItem(`ui-skin`, `sanctum`);
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`sanctum`);
        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
        expect(fontLink()).not.toBeNull();
    });

    it(`restores no skin just as well`, async () => {
        localStorage.setItem(`ui-skin`, `none`);
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`none`);
        expect(root().hasAttribute(`data-skin`)).toBe(false);
        expect(fontLink()).toBeNull();
    });

    it(`ignores a stored value that is not a skin`, async () => {
        localStorage.setItem(`ui-skin`, `neon`);
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`sanctum`);
        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });

    it(`turns the skin on: attribute, storage, webfont, and the dark scheme it is built for`, async () => {
        // Seeded OFF first: sanctum is the boot default, so setting it over nothing is a no-op write.
        localStorage.setItem(`ui-skin`, `none`);
        const { useSkin } = await load();

        useSkin().setSkin(`sanctum`);

        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
        expect(root().getAttribute(`data-mode`)).toBe(`dark`);
        expect(localStorage.getItem(`ui-skin`)).toBe(`sanctum`);
        expect(fontLink()).not.toBeNull();
    });

    // The detach, asserted: leaving the skin has to leave NOTHING, no attribute for a rule to match, no font
    // being paid for. Anything left behind here is the app not actually coming back to normal.
    it(`turns it off completely: no attribute left, no webfont left`, async () => {
        localStorage.setItem(`ui-skin`, `sanctum`);
        const { useSkin } = await load();

        useSkin().setSkin(`none`);

        expect(root().hasAttribute(`data-skin`)).toBe(false);
        expect(localStorage.getItem(`ui-skin`)).toBe(`none`);
        expect(fontLink()).toBeNull();
    });

    it(`asks for the webfont once, however many times a skin is applied`, async () => {
        const { useSkin } = await load();

        useSkin().setSkin(`sanctum`);
        useSkin().setSkin(`sanctum`);

        expect(document.querySelectorAll(`#ui-skin-font`)).toHaveLength(1);
    });

    // The one <link> must be REMOVED rather than left behind when the skin comes off, which is the bug the id
    // and the drop in applyFont exist to prevent.
    it(`drops the webfont when the skin comes off`, async () => {
        const { useSkin } = await load();

        useSkin().setSkin(`sanctum`);
        expect((fontLink() as HTMLLinkElement).href).toContain(`Baloo+2`);
        useSkin().setSkin(`none`);

        expect(fontLink()).toBeNull();
    });
});
