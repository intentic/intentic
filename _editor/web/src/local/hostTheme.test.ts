// @vitest-environment jsdom
//
// The host's theme channel (hostTheme.ts): the two roads a theme document arrives by — the env field at load,
// the message event live — and that a cleared or malformed document leaves the app's own look standing.
import { beforeEach, expect, it, vi } from "vitest";

// jsdom gap, filled before the imports land: hostTheme reaches the design-system barrel (useImportedTheme →
// @intentic/ui), whose module bodies call matchMedia while evaluating — the markdownFigures.test.ts idiom.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof matchMedia;
});

import { listenForHostTheme } from "./hostTheme";

// A minimal VSCode color-theme document the mapper accepts (vscodeTheme.ts reads `type` for the mode and
// `colors` for the chrome tokens).
const DARK_THEME = {
    name: "Host Dark",
    type: "dark",
    colors: { "editor.background": "#1e1e2e", "editor.foreground": "#cdd6f4" },
};

const chromeVar = (): string => document.documentElement.style.getPropertyValue("--color-canvas");

beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
    window.env = {
        production: false,
        api: { url: "" },
        auth: { googleClientId: "" },
        analytics: { posthogKey: "", posthogHost: "" },
        afterSignOut: "/login",
    };
});

it("applies the env-carried theme at load, and the mode rides with it", () => {
    window.env.local = { engineUrl: "http://127.0.0.1:1", theme: DARK_THEME };
    listenForHostTheme();
    expect(chromeVar()).not.toBe("");
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark");
});

it("a live message replaces the look, and theme:null clears back to the app's own", async () => {
    window.env.local = { engineUrl: "http://127.0.0.1:1" };
    listenForHostTheme();
    expect(chromeVar()).toBe("");

    window.postMessage({ type: "intentic:theme", theme: DARK_THEME }, "*");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chromeVar()).not.toBe("");

    window.postMessage({ type: "intentic:theme", theme: null }, "*");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chromeVar()).toBe("");
});

// Only the channel's own messages act — a stray postMessage from anything else sharing the window is inert.
// (A malformed document on the RIGHT channel is the mapper's business, and it maps to its defaults by design.)
it("an unrelated message changes nothing", async () => {
    window.env.local = { engineUrl: "http://127.0.0.1:1", theme: DARK_THEME };
    listenForHostTheme();
    const before = chromeVar();
    expect(before).not.toBe("");

    window.postMessage({ type: "something-else", theme: null }, "*");
    window.postMessage("plain string", "*");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chromeVar()).toBe(before);
});
