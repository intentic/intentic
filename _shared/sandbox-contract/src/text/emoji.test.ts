import { describe, expect, it } from "vitest";
import { isSingleEmoji } from "./emoji.js";

describe("isSingleEmoji", () => {
    it("takes one emoji however many code points it is made of", () => {
        expect(isSingleEmoji(`👍`)).toBe(true);
        // A skin tone, a ZWJ family and a flag are 2, 7 and 2 code points that each draw as one mark.
        expect(isSingleEmoji(`👍🏽`)).toBe(true);
        expect(isSingleEmoji(`👨‍👩‍👧‍👦`)).toBe(true);
        expect(isSingleEmoji(`🇵🇱`)).toBe(true);
        expect(isSingleEmoji(`🏴󠁧󠁢󠁳󠁣󠁴󠁿`)).toBe(true);
        // A keycap leads with an ASCII digit, which is why the pictographic property alone would refuse it.
        expect(isSingleEmoji(`1️⃣`)).toBe(true);
    });

    it("refuses everything that is not exactly one mark", () => {
        expect(isSingleEmoji(``)).toBe(false);
        expect(isSingleEmoji(`👍👎`)).toBe(false);
        expect(isSingleEmoji(`a`)).toBe(false);
        expect(isSingleEmoji(`lgtm`)).toBe(false);
        // The one a length check alone would let through: an emoji with a word stuck to it.
        expect(isSingleEmoji(`👍!`)).toBe(false);
        expect(isSingleEmoji(` `)).toBe(false);
    });

    it("refuses a string too long to be one grapheme without segmenting it", () => {
        expect(isSingleEmoji(`👍`.repeat(40))).toBe(false);
    });
});
