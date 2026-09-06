// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/* Compact (100%) is the shipped default — no attribute, scale 1. Comfortable (stored as `default`) and Large
 * set data-text-size. index.html's anti-flash script mirrors the same contract. */

const load = () => import("@intentic/ui/text-size");

beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute(`data-text-size`);
    vi.resetModules();
});

describe(`useTextSize`, () => {
    it(`opens at Compact with no attribute`, async () => {
        const { useTextSize } = await load();

        expect(useTextSize().textSize.value).toBe(`compact`);
        expect(useTextSize().scale.value).toBe(1);
        expect(document.documentElement.hasAttribute(`data-text-size`)).toBe(false);
    });

    it(`restores a saved size onto the document`, async () => {
        localStorage.setItem(`ui-text-size`, `large`);
        const { useTextSize } = await load();

        expect(useTextSize().textSize.value).toBe(`large`);
        expect(useTextSize().scale.value).toBeCloseTo(1.2);
        expect(document.documentElement.getAttribute(`data-text-size`)).toBe(`large`);
    });

    it(`restores Comfortable with the attribute set`, async () => {
        localStorage.setItem(`ui-text-size`, `default`);
        const { useTextSize } = await load();

        expect(useTextSize().textSize.value).toBe(`default`);
        expect(useTextSize().scale.value).toBeCloseTo(1.1);
        expect(document.documentElement.getAttribute(`data-text-size`)).toBe(`default`);
    });

    it(`ignores a stored value that is not a size`, async () => {
        localStorage.setItem(`ui-text-size`, `110%`);
        const { useTextSize } = await load();

        expect(useTextSize().textSize.value).toBe(`compact`);
    });

    it(`persists a change and clears the attribute for Compact`, async () => {
        const { useTextSize } = await load();
        const { setTextSize, textSize } = useTextSize();

        setTextSize(`default`);
        expect(textSize.value).toBe(`default`);
        expect(document.documentElement.getAttribute(`data-text-size`)).toBe(`default`);
        expect(localStorage.getItem(`ui-text-size`)).toBe(`default`);

        setTextSize(`compact`);
        expect(textSize.value).toBe(`compact`);
        expect(document.documentElement.hasAttribute(`data-text-size`)).toBe(false);
        expect(localStorage.getItem(`ui-text-size`)).toBe(`compact`);
    });
});
