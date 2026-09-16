// @vitest-environment jsdom
// Pins that the skin follows the scheme until somebody pins it, and that pinning it sets and clears data-skin.
// jsdom: the composable writes directly to the document. A skin used to fetch a webfont as it was applied and these
// also pinned that; every face is served from the app's own origin now, so there is no link left to assert on.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Each test re-imports fresh via vi.resetModules(), since the subject is a module-scope singleton; useSkin must keep
// reaching useTheme through @intentic/ui/theme, not the barrel, or each reset drags in the whole component graph.

const load = () => import("./useSkin");
const root = () => document.documentElement;

/** What the OS says, before the module under test reads it. jsdom has no `matchMedia` of its own. */
const systemIs = (scheme: "light" | "dark"): void => {
    vi.stubGlobal(`matchMedia`, (query: string) => ({
        matches: scheme === `dark` && query.includes(`dark`),
        addEventListener: (): void => {},
        removeEventListener: (): void => {},
    }));
};

beforeEach(() => {
    localStorage.clear();
    root().removeAttribute(`data-skin`);
    root().removeAttribute(`data-mode`);
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe(`useSkin`, () => {
    it(`wears sanctum when nobody has chosen and the system is dark`, async () => {
        systemIs(`dark`);
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`sanctum`);
        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });

    // The reason the default moved: sanctum is built on a near-black canvas and has no daylight dress, so wearing it
    // over a light system was the app arriving in the wrong light on every screen before sign-in.
    it(`wears nothing when nobody has chosen and the system is light`, async () => {
        systemIs(`light`);
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`none`);
        expect(root().hasAttribute(`data-skin`)).toBe(false);
    });

    it(`restores a pinned skin over what the system would have asked for`, async () => {
        systemIs(`light`);
        localStorage.setItem(`ui-skin`, `sanctum`);
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`sanctum`);
        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
    });

    it(`restores a pinned "none" just as well`, async () => {
        systemIs(`dark`);
        localStorage.setItem(`ui-skin`, `none`);
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`none`);
        expect(root().hasAttribute(`data-skin`)).toBe(false);
    });

    it(`treats a stored value that is not a skin as nobody having chosen`, async () => {
        systemIs(`dark`);
        localStorage.setItem(`ui-skin`, `neon`);
        const { useSkin } = await load();

        expect(useSkin().choice.value).toBe(`system`);
        expect(useSkin().skin.value).toBe(`sanctum`);
    });

    it(`turns the skin on: attribute, storage, and the dark scheme it is built for`, async () => {
        systemIs(`light`);
        const { useSkin } = await load();

        useSkin().setSkin(`sanctum`);

        expect(root().getAttribute(`data-skin`)).toBe(`sanctum`);
        expect(root().getAttribute(`data-mode`)).toBe(`dark`);
        expect(localStorage.getItem(`ui-skin`)).toBe(`sanctum`);
    });

    it(`turns it off completely: no attribute left, and the scheme stays where it was`, async () => {
        systemIs(`dark`);
        localStorage.setItem(`ui-skin`, `sanctum`);
        const { useSkin } = await load();

        useSkin().setSkin(`none`);

        expect(root().hasAttribute(`data-skin`)).toBe(false);
        expect(localStorage.getItem(`ui-skin`)).toBe(`none`);
        expect(root().getAttribute(`data-mode`)).toBe(`dark`);
    });

    // Handing the skin back to the system must not pin the very scheme the reader just released.
    it(`hands the skin back to the system without pinning the scheme`, async () => {
        systemIs(`light`);
        localStorage.setItem(`ui-skin`, `sanctum`);
        const { useSkin } = await load();

        useSkin().setSkin(`system`);

        expect(useSkin().skin.value).toBe(`none`);
        expect(root().hasAttribute(`data-skin`)).toBe(false);
        expect(localStorage.getItem(`ui-color-scheme`)).toBeNull();
    });
});
