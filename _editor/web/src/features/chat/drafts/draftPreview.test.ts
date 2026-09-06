import { describe, expect, it } from "vitest";
import { draftPreview } from "./draftPreview";

/* The name a card wears while nothing else has named it. Short enough for a lane, long enough to tell two
 * drafts apart, and one line whatever was pasted into the box. */
describe(`draftPreview`, () => {
    it(`is nothing at all for an empty composer, so the card keeps its "New agent"`, () => {
        expect(draftPreview(``)).toBeUndefined();
        expect(draftPreview(`   \n  `)).toBeUndefined();
    });

    it(`hands back a short message whole`, () => {
        expect(draftPreview(`  fix the login redirect  `)).toBe(`fix the login redirect`);
    });

    it(`folds a pasted paragraph onto one line`, () => {
        expect(draftPreview(`fix the\n\n  login   redirect`)).toBe(`fix the login redirect`);
    });

    it(`cuts a long message at a word, so the title reads as words rather than as a slice`, () => {
        const preview = draftPreview(`refactor the whole authentication layer and then write the tests for it`);
        expect(preview).toBe(`refactor the whole authentication layer and…`);
    });

    // A single enormous token has no word boundary worth cutting at: clipping it is better than a two-letter title.
    it(`clips a single enormous word rather than leaving two letters of it`, () => {
        expect(draftPreview(`a${`x`.repeat(80)}`)).toBe(`${`a${`x`.repeat(47)}`}…`);
    });
});
