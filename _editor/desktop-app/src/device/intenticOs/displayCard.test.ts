import {
    isBuiltIn,
    modeForRate,
    modeForSize,
    percentOf,
    rateKeyOf,
    rateLabelOf,
    recommendedOf,
    resolutionsOf,
    sameMode,
    scaleKeyOf,
    scalesFor,
    screenNameOf,
} from "./displayCard";
import { example, GOLDEN } from "./golden.testing";

// The screens as the card reads them: what a person calls each, the sizes it offers and the rates in each, the mode a
// pick comes to, and how big everything is drawn. The screens are the contract's own example of `ic os display list`: a
// laptop's built-in screen, a Dell monitor, and a screen plugged in but off.

const screens = example(GOLDEN.displayList).outputs;
const laptop = example(screens, 0);
const monitor = example(screens, 1);
const off = example(screens, 2);

describe(`a screen's name`, () => {
    it(`is the built-in one as such, else its model, else its maker, else none`, () => {
        expect(isBuiltIn(laptop)).toBe(true);
        expect(screenNameOf(laptop)).toEqual({ kind: `builtIn` });
        expect(screenNameOf(monitor)).toEqual({ kind: `named`, name: `DELL U2720Q` });
        expect(screenNameOf(off)).toEqual({ kind: `unnamed` });
        // A hex code is no name.
        expect(screenNameOf({ ...off, make: `BOE`, model: `0x095F` })).toEqual({ kind: `named`, name: `BOE` });
        expect(screenNameOf({ ...off, name: `LVDS-1` })).toEqual({ kind: `builtIn` });
    });
});

describe(`the sizes a screen offers`, () => {
    it(`are the most pixels first, each with its rates fastest first, each rate once`, () => {
        expect(resolutionsOf(monitor)).toEqual([
            { key: `3840x2160`, width: 3840, height: 2160, rates: [60, 29.981] },
            { key: `2560x1440`, width: 2560, height: 1440, rates: [59.951] },
            { key: `1920x1080`, width: 1920, height: 1080, rates: [60, 59.94] },
        ]);
        expect(recommendedOf(monitor)).toBe(`3840x2160`);
        // 59.999 and 60.004 are one rate.
        expect(resolutionsOf({ ...laptop, modes: [...laptop.modes, { width: 2256, height: 1504, refresh: 60.004 }] })[0]?.rates).toEqual([59.999, 48]);
        expect(recommendedOf({ ...off, modes: [] })).toBeUndefined();
    });

    it(`are said the way a person reads a rate, and keyed the way ic writes it`, () => {
        expect([60, 59.94, 59.999, 29.981].map(rateLabelOf)).toEqual([`60`, `59.94`, `60`, `29.98`]);
        expect([60, 59.94, 59.999, 29.981].map(rateKeyOf)).toEqual([`60`, `59.94`, `59.999`, `29.981`]);
        expect(sameMode({ width: 1, height: 2, refresh: 59.999 }, { width: 1, height: 2, refresh: 60 })).toBe(true);
        expect(sameMode({ width: 1, height: 2, refresh: 59.94 }, { width: 1, height: 2, refresh: 60 })).toBe(false);
    });
});

describe(`a pick`, () => {
    it(`of another size keeps the rate the screen runs at where it can, else takes the size's fastest`, () => {
        expect(modeForSize(monitor, `1920x1080`)).toEqual({ width: 1920, height: 1080, refresh: 60 });
        expect(modeForSize(monitor, `2560x1440`)).toEqual({ width: 2560, height: 1440, refresh: 59.951 });
        expect(modeForSize(monitor, `800x600`)).toBeUndefined();
        expect(modeForSize(off, `1920x1080`)).toEqual({ width: 1920, height: 1080, refresh: 60 });
    });

    it(`of another rate keeps the size the screen shows`, () => {
        expect(modeForRate(monitor, `29.981`)).toEqual({ width: 3840, height: 2160, refresh: 29.981 });
        expect(modeForRate(monitor, `59.94`)).toBeUndefined();
        expect(modeForRate(off, `60`)).toBeUndefined();
    });
});

describe(`how big everything is drawn`, () => {
    it(`offers the usual five, and the size a screen has where it is none of them`, () => {
        expect(scalesFor(1.5)).toEqual([1, 1.25, 1.5, 1.75, 2]);
        expect(scalesFor(null)).toEqual([1, 1.25, 1.5, 1.75, 2]);
        expect(scalesFor(1.333)).toEqual([1, 1.25, 1.333, 1.5, 1.75, 2]);
        expect(scalesFor(3)).toEqual([1, 1.25, 1.5, 1.75, 2, 3]);
        expect([1, 1.25, 1.333, 2].map(percentOf)).toEqual([100, 125, 133, 200]);
        expect(scaleKeyOf(laptop.scale)).toBe(`150`);
        expect(scaleKeyOf(off.scale)).toBeUndefined();
    });
});
