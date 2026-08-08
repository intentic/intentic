// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/* The base text size ships as a DEFAULT, so what these pin is mostly what happens when nobody has chosen: a
 * fresh window is the 110% the interface is drawn at, and it says so by carrying no attribute at all (the
 * stylesheet's own value — see tokens.css). The attribute only ever appears for the two sizes that are a
 * departure from it, which is also the contract index.html's anti-flash script is written against. */

const load = () => import("@intentic/ui/text-size");

beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute(`data-text-size`);
    vi.resetModules();
});

describe(`useTextSize`, () => {
    it(`opens at the size the app is drawn for, with no attribute to say so`, async () => {
        const { useTextSize } = await load();

        expect(useTextSize().textSize.value).toBe(`default`);
        expect(useTextSize().scale.value).toBeCloseTo(1.1);
        expect(document.documentElement.hasAttribute(`data-text-size`)).toBe(false);
    });

    it(`restores a saved size onto the document`, async () => {
        localStorage.setItem(`ui-text-size`, `large`);
        const { useTextSize } = await load();

        expect(useTextSize().textSize.value).toBe(`large`);
        expect(useTextSize().scale.value).toBeCloseTo(1.2);
        expect(document.documentElement.getAttribute(`data-text-size`)).toBe(`large`);
    });

    it(`ignores a stored value that is not a size`, async () => {
        localStorage.setItem(`ui-text-size`, `110%`);
        const { useTextSize } = await load();

        expect(useTextSize().textSize.value).toBe(`default`);
    });

    it(`persists a change and takes the attribute back off for the default`, async () => {
        const { useTextSize } = await load();
        const { setTextSize, textSize } = useTextSize();

        setTextSize(`compact`);
        expect(textSize.value).toBe(`compact`);
        expect(document.documentElement.getAttribute(`data-text-size`)).toBe(`compact`);
        expect(localStorage.getItem(`ui-text-size`)).toBe(`compact`);

        setTextSize(`default`);
        expect(document.documentElement.hasAttribute(`data-text-size`)).toBe(false);
        expect(localStorage.getItem(`ui-text-size`)).toBe(`default`);
    });
});
