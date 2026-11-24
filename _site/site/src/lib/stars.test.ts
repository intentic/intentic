/// <reference types="bun" />
/// <reference types="@intentic/testing/globals" />
import { formatStars, starsPhrase } from "./stars";

describe("formatStars", () => {
    it("prints a count under a thousand as it is", () => {
        expect(formatStars(0)).toBe("0");
        expect(formatStars(99)).toBe("99");
        expect(formatStars(999)).toBe("999");
    });

    it("keeps one decimal below ten thousand and cuts rather than rounds", () => {
        expect(formatStars(1000)).toBe("1k");
        expect(formatStars(1234)).toBe("1.2k");
        expect(formatStars(1999)).toBe("1.9k");
    });

    it("drops the decimal from ten of a unit up", () => {
        expect(formatStars(12_345)).toBe("12k");
        expect(formatStars(999_999)).toBe("999k");
        expect(formatStars(1_250_000)).toBe("1.2M");
    });
});

describe("starsPhrase", () => {
    it("says the exact figure, grouped, with the right number", () => {
        expect(starsPhrase(1)).toBe("1 star");
        expect(starsPhrase(1234)).toBe("1,234 stars");
    });
});
