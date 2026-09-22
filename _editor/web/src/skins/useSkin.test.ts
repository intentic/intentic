// Pins that the skin follows the scheme until somebody pins it, and that pinning it sets and clears data-skin.
// jsdom: the composable writes directly to the document. A skin used to fetch a webfont as it was applied and these
// also pinned that; every face is served from the app's own origin now, so there is no link left to assert on.
import "@intentic/testing/dom";
import { describe, it, expect, beforeEach } from "bun:test";
import { freshImport, stubGlobal } from "@intentic/testing/bun";

// Both modules are module-scope singletons. The theme is evaluated once, over a `prefers-color-scheme` this file can
// flip live, and the skin gets its own evaluation per case, since what it reads from storage as it loads is half of
// what these pin. useSkin must keep reaching useTheme through @intentic/ui/theme, not the barrel, or each evaluation
// drags in the whole component graph.

/** What the OS says. jsdom has no `matchMedia`, and the preload's stand-in never changes. */
const listeners = new Set<(event: { matches: boolean }) => void>();
let dark = false;
stubGlobal(`matchMedia`, (query: string) => ({
    get matches(): boolean {
        return dark && query.includes(`dark`);
    },
    addEventListener: (_name: string, listener: (event: { matches: boolean }) => void): void => void listeners.add(listener),
    removeEventListener: (_name: string, listener: (event: { matches: boolean }) => void): void => void listeners.delete(listener),
}));

const systemIs = (scheme: "light" | "dark"): void => {
    dark = scheme === `dark`;
    for (const listener of listeners) {
        listener({ matches: dark });
    }
};

// Imported after the stub above, so the one instance this file holds reads and follows it.
const { useTheme } = await import("@intentic/ui/theme");

const load = () => freshImport<typeof import("./useSkin")>("./useSkin", import.meta.url);
const root = () => document.documentElement;

beforeEach(() => {
    // The scheme is handed back to the system first, then what that wrote is cleared: the theme is one instance for
    // the whole file, so a case that pinned it would otherwise carry into the next.
    useTheme().set(`system`);
    systemIs(`light`);
    localStorage.clear();
    root().removeAttribute(`data-skin`);
    root().removeAttribute(`data-mode`);
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
