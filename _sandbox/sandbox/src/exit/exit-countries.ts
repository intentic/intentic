import { type ExitPoint, TOR_EXIT_COUNTRIES, VPNGATE_EXIT_COUNTRIES } from "@intentic/sandbox-contract";

// What a country code means here: a name to render, a timezone/locale to dress a browser in, and a baked per-provider
// fallback list. Names and locale come from ICU (ships with Node); no hand-written tables for either.

// `fallback: "none"` makes an unassigned code answer undefined, not echoed back, which isCountryCode relies on.
const regionNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

// CLDR's own placeholders (ZZ "Unknown Region", XA/XB pseudo-locales), none a country an exit comes out of.
const NON_COUNTRIES = new Set(["ZZ", "XA", "XB"]);

// Whether two letters name a real country; the gate on every code this subsystem accepts from a config file, hostname,
// or CSV.
export const isCountryCode = (code: string): boolean => {
    if (!/^[A-Za-z]{2}$/.test(code) || NON_COUNTRIES.has(code.toUpperCase())) {
        return false;
    }
    try {
        return regionNames.of(code.toUpperCase()) !== undefined;
    } catch {
        return false;
    }
};

// "DE" -> "Germany"; falls back to the code itself for anything ICU declines, never throws.
export const countryName = (code: string): string => {
    try {
        return (NON_COUNTRIES.has(code.toUpperCase()) ? undefined : regionNames.of(code.toUpperCase())) ?? code.toUpperCase();
    } catch {
        return code.toUpperCase();
    }
};

// The clock and language that make a spoofed address sensible: a German IP under a New York clock is a bigger tell than
// the address alone. Derived from ICU (`und-<CC>` maximized), not tabulated.
export interface CountryLocale {
    readonly timezone: string;
    readonly locale: string;
    // Accept-Language / navigator.languages order, most-preferred first; English is always included as a fallback.
    readonly languages: readonly string[];
}

// Deliberate zone for multi-zone countries (ICU defaults to alphabetically first, e.g. America/Adak for the US).
const PRINCIPAL_ZONE: Readonly<Record<string, string>> = {
    US: "America/New_York",
    CA: "America/Toronto",
    BR: "America/Sao_Paulo",
    AU: "Australia/Sydney",
    RU: "Europe/Moscow",
    MX: "America/Mexico_City",
    ID: "Asia/Jakarta",
    CN: "Asia/Shanghai",
    KZ: "Asia/Almaty",
    AR: "America/Argentina/Buenos_Aires",
    CL: "America/Santiago",
    ES: "Europe/Madrid",
    PT: "Europe/Lisbon",
    NZ: "Pacific/Auckland",
    UA: "Europe/Kyiv",
};

// `Intl.Locale#getTimeZones` is a V8 extension not yet in TS's lib; declared narrowly here and feature-detected, not
// assumed.
type LocaleWithZones = Intl.Locale & { getTimeZones?: () => readonly string[] };

export const countryLocale = (code: string): CountryLocale => {
    const cc = code.toUpperCase();
    let timezone = PRINCIPAL_ZONE[cc];
    let language = "en";
    try {
        const locale: LocaleWithZones = new Intl.Locale(`und-${cc}`);
        if (timezone === undefined) {
            // First entry is ICU's canonical zone, and the only one for single-zone countries not in the table above.
            timezone = locale.getTimeZones?.()[0];
        }
        language = locale.maximize().language;
    } catch {
        // Unknown code: keep the UTC/English default instead of failing a launch over a label.
    }
    const primary = `${language}-${cc}`;
    return {
        timezone: timezone ?? "Etc/UTC",
        locale: primary,
        languages: language === "en" ? [primary, "en"] : [primary, language, "en"],
    };
};

// Re-exported from the contract's own catalogs, not duplicated, so the add form's picker and every driver read the same
// lists a driver can actually dial.
export const TOR_FALLBACK = TOR_EXIT_COUNTRIES;
export const VPNGATE_FALLBACK = VPNGATE_EXIT_COUNTRIES;

// Countries to ranked ExitPoints from a bare per-country server count; shared by every driver that builds a catalog by
// tallying, so ranking and naming are defined once.
export const rankCountries = (counts: ReadonlyMap<string, number>): ExitPoint[] => {
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    const points: ExitPoint[] = [];
    for (const [country, servers] of counts) {
        points.push(
            total > 0
                ? { country, countryName: countryName(country), servers, share: servers / total }
                : { country, countryName: countryName(country), servers },
        );
    }
    return points.toSorted((a, b) => b.servers - a.servers || a.country.localeCompare(b.country));
};
