import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";

/* Compact (100%) is the shipped default — no attribute, scale 1. */

// Storage and the anti-flash attribute are read once, at module scope, so each case needs its own evaluation of it.
const TEXT_SIZE = import.meta.resolve("@intentic/ui/text-size");
const load = () => freshImport<typeof import("@intentic/ui/text-size")>(TEXT_SIZE, import.meta.url);

beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute(`data-text-size`);
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
