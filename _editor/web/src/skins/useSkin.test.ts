// @vitest-environment jsdom
// Pins that turning a skin on or off sets and clears data-skin and its webfont link together. jsdom: the composable
// writes directly to the document.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Each test re-imports fresh via vi.resetModules(), since the subject is a module-scope singleton; useSkin must keep
// reaching useTheme through @intentic/ui/theme, not the barrel, or each reset drags in the whole component graph.

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
        // Seeded to `none` first, since sanctum is already the boot default and wouldn't exercise the write.
        localStorage.setItem(`ui-skin`, `none`);
        const { useSkin } = await load();

        useSkin().setSkin(`sanctum`);

        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
        expect(root().getAttribute(`data-mode`)).toBe(`dark`);
        expect(localStorage.getItem(`ui-skin`)).toBe(`sanctum`);
        expect(fontLink()).not.toBeNull();
    });

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

    it(`drops the webfont when the skin comes off`, async () => {
        const { useSkin } = await load();

        useSkin().setSkin(`sanctum`);
        expect((fontLink() as HTMLLinkElement).href).toContain(`Baloo+2`);
        useSkin().setSkin(`none`);

        expect(fontLink()).toBeNull();
    });
});
