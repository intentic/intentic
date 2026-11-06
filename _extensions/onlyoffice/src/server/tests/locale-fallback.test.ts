import { fillLocale, translationsOf } from "../locale-fallback.js";

// A translation filled from English: what it translates stays, what it lacks is English, and anything that is not a
// string of text counts as lacking.

describe(`filling a translation from English`, () => {
    it(`keeps its own strings and takes the rest from English`, () => {
        const english = new Map([
            [`a`, `Animation Pane`],
            [`b`, `Zoom`],
        ]);
        const filled = fillLocale(english, new Map([[`b`, `Powiększenie`]]));
        expect(Object.fromEntries(filled)).toEqual({ a: `Animation Pane`, b: `Powiększenie` });
    });

    it(`reads only text values out of a locale file`, () => {
        expect(Object.fromEntries(translationsOf({ a: `x`, b: ``, c: 1, d: null }) ?? [])).toEqual({ a: `x` });
        expect(translationsOf([`a`])).toBeUndefined();
        expect(translationsOf(`a`)).toBeUndefined();
    });
});
