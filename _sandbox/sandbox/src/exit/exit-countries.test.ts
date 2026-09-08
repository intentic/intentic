import { expect, test } from "vitest";
import { countryLocale, countryName, isCountryCode, rankCountries, TOR_FALLBACK, VPNGATE_FALLBACK } from "./exit-countries.js";

test("country codes render as names, case-insensitively, and never throw", () => {
    expect(countryName("DE")).toBe("Germany");
    expect(countryName("de")).toBe("Germany");
    expect(countryName("JP")).toBe("Japan");
    // ZZ is CLDR's placeholder for "Unknown Region", not a country an exit can come out of.
    expect(countryName("ZZ")).toBe("ZZ");
    expect(countryName("QQ")).toBe("QQ");
    expect(countryName("!!")).toBe("!!");
});

test("only real countries pass the code gate", () => {
    // Without this gate, ICU's own placeholders and fallback-to-input make every input look like a valid country.
    expect(isCountryCode("DE")).toBe(true);
    expect(isCountryCode("de")).toBe(true);
    expect(isCountryCode("ZZ")).toBe(false);
    expect(isCountryCode("XA")).toBe(false);
    expect(isCountryCode("QQ")).toBe(false);
    expect(isCountryCode("D")).toBe(false);
    expect(isCountryCode("DEU")).toBe(false);
});

test("a country carries a plausible clock and language, not just an address", () => {
    const de = countryLocale("DE");
    expect(de.timezone).toBe("Europe/Berlin");
    expect(de.locale).toBe("de-DE");
    expect(de.languages).toEqual(["de-DE", "de", "en"]);

    const jp = countryLocale("JP");
    expect(jp.timezone).toBe("Asia/Tokyo");
    expect(jp.locale).toBe("ja-JP");

    // English-speaking countries get no duplicate "en" in their language list.
    expect(countryLocale("GB").languages).toEqual(["en-GB", "en"]);
});

test("multi-zone countries get the populous zone, not ICU's alphabetically first", () => {
    expect(countryLocale("US").timezone).toBe("America/New_York");
    expect(countryLocale("BR").timezone).toBe("America/Sao_Paulo");
    expect(countryLocale("AU").timezone).toBe("Australia/Sydney");
});

test("an unknown country still produces a usable launch dressing", () => {
    const unknown = countryLocale("ZZ");
    expect(unknown.timezone).toBe("Etc/UTC");
    expect(unknown.languages).toContain("en");
});

test("counted countries rank by how much is actually there", () => {
    const ranked = rankCountries(
        new Map([
            ["DE", 4],
            ["JP", 9],
            ["FR", 1],
        ]),
    );
    expect(ranked.map((point) => point.country)).toEqual(["JP", "DE", "FR"]);
    expect(ranked[0]?.countryName).toBe("Japan");
    expect(ranked[0]?.share).toBeCloseTo(9 / 14);
    // An empty pool is a legal answer (no exit pasted yet), not a divide by zero.
    expect(rankCountries(new Map())).toEqual([]);
});

test("the baked fallbacks are honest about each provider's shape", () => {
    // Tor's fallback ranks by capacity, not relay count.
    expect(TOR_FALLBACK[0]?.country).toBe("NL");
    expect(TOR_FALLBACK.find((point) => point.country === "US")?.servers).toBeGreaterThan(TOR_FALLBACK[0]?.servers ?? 0);
    expect(TOR_FALLBACK[0]?.share ?? 0).toBeGreaterThan(TOR_FALLBACK.find((point) => point.country === "US")?.share ?? 1);

    // VPN Gate really is a Japan/Korea service; the fallback must not pretend otherwise.
    const asian = VPNGATE_FALLBACK.filter((point) => point.country === "JP" || point.country === "KR");
    const total = VPNGATE_FALLBACK.reduce((sum, point) => sum + point.servers, 0);
    expect(asian.reduce((sum, point) => sum + point.servers, 0) / total).toBeGreaterThan(0.8);
});
