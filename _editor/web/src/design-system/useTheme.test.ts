import "@intentic/testing/dom";
import { describe, it, expect, beforeEach } from "bun:test";
import { freshImport, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";

// The scheme is the one preference with THREE states and two of them spell the same attribute: `system` is the
// default, and the only value that can move without anybody choosing. Light is what a browser that will not say
// gets — `no-preference` matches neither query, which is what jsdom's own matchMedia already models.

// The module reads the OS query, the announcement and storage once, at module scope, so each case needs its own
// evaluation of it; freshImport takes a URL, which is what the package subpath resolves to.
const THEME = import.meta.resolve("@intentic/ui/theme");
const load = () => freshImport<typeof import("@intentic/ui/theme")>(THEME, import.meta.url);
const root = () => document.documentElement;

/** A `prefers-color-scheme` the test can flip; jsdom's own never matches and never changes. */
const systemIs = (scheme: "light" | "dark") => {
    const listeners = new Set<(event: { matches: boolean }) => void>();
    let dark = scheme === `dark`;
    stubGlobal(`matchMedia`, (query: string) => ({
        get matches(): boolean {
            return dark && query.includes(`dark`);
        },
        addEventListener: (_name: string, listener: (event: { matches: boolean }) => void): void => void listeners.add(listener),
        removeEventListener: (_name: string, listener: (event: { matches: boolean }) => void): void => void listeners.delete(listener),
    }));
    return {
        flip: (next: "light" | "dark"): void => {
            dark = next === `dark`;
            for (const listener of listeners) {
                listener({ matches: dark });
            }
        },
    };
};

beforeEach(() => {
    localStorage.clear();
    root().removeAttribute(`data-mode`);
    unstubAllGlobals();
});

describe(`the scheme nobody has chosen`, () => {
    it(`opens in daylight when the browser will not say`, async () => {
        const { useTheme } = await load();

        expect(useTheme().choice.value).toBe(`system`);
        expect(useTheme().scheme.value).toBe(`light`);
        expect(root().hasAttribute(`data-mode`)).toBe(false);
    });

    it(`opens dark when the system is dark`, async () => {
        systemIs(`dark`);
        const { useTheme } = await load();

        expect(useTheme().scheme.value).toBe(`dark`);
        expect(root().getAttribute(`data-mode`)).toBe(`dark`);
    });

    // The whole point of holding `system` rather than resolving it once: an OS that flips at dusk carries the app.
    it(`repaints when the system flips under it`, async () => {
        const os = systemIs(`light`);
        const { useTheme } = await load();

        os.flip(`dark`);

        expect(useTheme().scheme.value).toBe(`dark`);
        expect(root().getAttribute(`data-mode`)).toBe(`dark`);
        // Following is not choosing: nothing is written down, so the next flip is still the OS's to make.
        expect(localStorage.getItem(`ui-color-scheme`)).toBeNull();
    });

    it(`treats a stored value that is not a scheme as nobody having chosen`, async () => {
        localStorage.setItem(`ui-color-scheme`, `sepia`);
        const { useTheme } = await load();

        expect(useTheme().choice.value).toBe(`system`);
    });
});

describe(`a scheme somebody chose`, () => {
    it(`outranks the system, and stops following it`, async () => {
        const os = systemIs(`dark`);
        const { useTheme } = await load();

        useTheme().set(`light`);
        os.flip(`light`);
        os.flip(`dark`);

        expect(useTheme().scheme.value).toBe(`light`);
        expect(root().hasAttribute(`data-mode`)).toBe(false);
        expect(localStorage.getItem(`ui-color-scheme`)).toBe(`light`);
    });

    it(`goes back to the system when it is handed back`, async () => {
        const os = systemIs(`dark`);
        localStorage.setItem(`ui-color-scheme`, `light`);
        const { useTheme } = await load();

        useTheme().set(`system`);

        expect(useTheme().scheme.value).toBe(`dark`);
        expect(root().getAttribute(`data-mode`)).toBe(`dark`);
        expect(localStorage.getItem(`ui-color-scheme`)).toBe(`system`);
        os.flip(`light`);
        expect(useTheme().scheme.value).toBe(`light`);
    });

    // A toggle answers "the other one", so it always lands on a pin — never back on `system`, which has no other one.
    it(`pins the opposite of what is on screen when toggled`, async () => {
        systemIs(`dark`);
        const { useTheme } = await load();

        useTheme().toggle();

        expect(useTheme().choice.value).toBe(`light`);
        expect(root().hasAttribute(`data-mode`)).toBe(false);
    });
});

// The desktop app's own faces stand INSIDE a workspace and are handed its scheme by the binary before they paint
// (windows.rs `face_init_script`); that is a fact about the window, not a preference this page may hold.
describe(`a scheme the desktop app announced`, () => {
    it(`outranks both the setting and the system`, async () => {
        systemIs(`light`);
        localStorage.setItem(`ui-color-scheme`, `light`);
        stubGlobal(`__INTENTIC_MODE__`, `dark`);
        const { useTheme } = await load();

        expect(useTheme().scheme.value).toBe(`dark`);
        expect(root().getAttribute(`data-mode`)).toBe(`dark`);
    });
});
