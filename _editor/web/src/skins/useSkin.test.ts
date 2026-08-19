// @vitest-environment jsdom
//
// jsdom because the whole subject is what the composable does to the DOCUMENT: the attribute every rule in
// hud.css hangs off, and the webfont <link> that must not be there when no skin is on.
import { beforeEach, describe, expect, it, vi } from "vitest";

// `useSkin` reaches `useTheme` through the design system's barrel, which pulls in app-wide singletons that read
// browser globals at import time (useDevice reads window.matchMedia). vi.hoisted runs above every import in the
// transformed module, which is what puts the shim in place before that happens.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
});

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
    it(`defaults to no skin, and writes no attribute for it`, async () => {
        const { useSkin } = await load();

        expect(useSkin().skin.value).toBe(`none`);
        expect(root().hasAttribute(`data-skin`)).toBe(false);
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

        expect(useSkin().skin.value).toBe(`none`);
        expect(root().hasAttribute(`data-skin`)).toBe(false);
    });

    it(`turns the HUD on: attribute, storage, webfont, and the dark scheme it is built for`, async () => {
        const { useSkin } = await load();

        useSkin().setSkin(`hud`);

        expect(root().getAttribute(`data-skin`)).toBe(`hud`);
        expect(root().getAttribute(`data-mode`)).toBe(`dark`);
        expect(localStorage.getItem(`ui-skin`)).toBe(`hud`);
        expect(fontLink()).not.toBeNull();
    });

    // The detach, asserted: leaving the skin has to leave NOTHING — no attribute for a rule to match, no font
    // being paid for. Anything left behind here is the app not actually coming back to normal.
    it(`turns it off completely — no attribute left, no webfont left`, async () => {
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
    // a second one behind it — which is the bug the id and the re-point in applyFont exist to prevent.
    it(`swaps one webfont for the other when the skin changes`, async () => {
        const { useSkin } = await load();

        useSkin().setSkin(`hud`);
        const first = (fontLink() as HTMLLinkElement).href;
        useSkin().setSkin(`sanctum`);
        const second = (fontLink() as HTMLLinkElement).href;

        expect(document.querySelectorAll(`#ui-skin-font`)).toHaveLength(1);
        expect(first).toContain(`Chakra+Petch`);
        expect(second).toContain(`Cinzel`);
    });
});
