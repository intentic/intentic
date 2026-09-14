// @vitest-environment jsdom
// Pins that turning a skin on or off sets and clears data-skin. jsdom: the composable writes directly to the
// document. A skin used to fetch a webfont as it was applied and these also pinned that; every face is served from
// the app's own origin now, so there is no link left to assert on.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Each test re-imports fresh via vi.resetModules(), since the subject is a module-scope singleton; useSkin must keep
// reaching useTheme through @intentic/ui/theme, not the barrel, or each reset drags in the whole component graph.

const load = () => import("./useSkin");
const root = () => document.documentElement;

beforeEach(() => {
    localStorage.clear();
    root().removeAttribute(`data-skin`);
    root().removeAttribute(`data-mode`);
    vi.resetModules();
});

describe(`useSkin`, () => {
    it(`defaults to sanctum`, async () => {
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`sanctum`);
        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });

    it(`restores a stored skin on load`, async () => {
        localStorage.setItem(`ui-skin`, `sanctum`);
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`sanctum`);
        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });

    it(`restores no skin just as well`, async () => {
        localStorage.setItem(`ui-skin`, `none`);
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`none`);
        expect(root().hasAttribute(`data-skin`)).toBe(false);
    });

    it(`ignores a stored value that is not a skin`, async () => {
        localStorage.setItem(`ui-skin`, `neon`);
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`sanctum`);
        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });

    it(`turns the skin on: attribute, storage, and the dark scheme it is built for`, async () => {
        // Seeded to `none` first, since sanctum is already the boot default and wouldn't exercise the write.
        localStorage.setItem(`ui-skin`, `none`);
        const { useSkin } = await load();

        useSkin().setSkin(`sanctum`);

        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
        expect(root().getAttribute(`data-mode`)).toBe(`dark`);
        expect(localStorage.getItem(`ui-skin`)).toBe(`sanctum`);
    });

    it(`turns it off completely: no attribute left`, async () => {
        localStorage.setItem(`ui-skin`, `sanctum`);
        const { useSkin } = await load();

        useSkin().setSkin(`none`);

        expect(root().hasAttribute(`data-skin`)).toBe(false);
        expect(localStorage.getItem(`ui-skin`)).toBe(`none`);
    });
});
