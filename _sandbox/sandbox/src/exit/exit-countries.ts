import { type ExitPoint, TOR_EXIT_COUNTRIES, VPNGATE_EXIT_COUNTRIES } from "@intentic/sandbox-contract";

// What a country code MEANS, in the three ways this subsystem needs it: a name to render, a timezone and a
// locale to dress a browser in, and a baked list of where each free provider can actually come out when the
// provider's own catalog cannot be reached.
//
// No lookup tables for the first two. ICU already knows every one of these mappings and ships with Node, so a
// hand-written table would only be a second, staler copy of it.

/* `fallback: "none"` so an unassigned code answers `undefined` instead of being echoed back, which is what
 * makes isCountryCode below able to tell a real country from two arbitrary letters. Without it every input is
 * "valid" and the auto-labelling in wireguard-exit.ts would read `# my-server-1` as Malaysia. */
const regionNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

// CLDR's own placeholders, which ICU dutifully names: ZZ is "Unknown Region", XA/XB are the pseudo-locale
// regions used for translation testing. All real answers from ICU's point of view, none of them a country an
// exit can come out of.
const NON_COUNTRIES = new Set(["ZZ", "XA", "XB"]);

// Whether two letters name an actual country. The gate on every code this subsystem accepts from a config
// file, a hostname or a CSV, none of which are trustworthy about it.
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

// "DE" → "Germany". Falls back to the code itself for anything ICU declines, which renders as a slightly worse
// label and never as a crash.
export const countryName = (code: string): string => {
    try {
        return (NON_COUNTRIES.has(code.toUpperCase()) ? undefined : regionNames.of(code.toUpperCase())) ?? code.toUpperCase();
    } catch {
        return code.toUpperCase();
    }
};

/* THE FINGERPRINT HALF OF A COUNTRY. An exit moves the address; these move the clock and the language, and
 * without them the address is the only thing that moved. A German address with a New York clock and en-US as
 * the only accepted language is a sharper signal than a datacenter IP on its own, because no real visitor
 * looks like that, so the browser wiring dresses a profile in these whenever it puts one behind an exit.
 *
 * Derived from ICU rather than tabulated. `und-DE` is "some language, region Germany", which is exactly the
 * question being asked, and maximize() answers it with the language actually spoken there. */
export interface CountryLocale {
    readonly timezone: string;
    readonly locale: string;
    // Accept-Language / navigator.languages, most-preferred first. English is kept as a fallback because it is
    // present on almost every real browser and its absence is itself unusual.
    readonly languages: readonly string[];
}

// Countries spanning many zones (US, BR, AU, RU) get a deliberate pick rather than ICU's alphabetically-first
// entry, which is how you end up claiming to be in America/Adak. The most populous zone is the least
// surprising answer and the one a real visitor is most likely to be in.
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

// `Intl.Locale#getTimeZones` is implemented in V8 and not yet in TypeScript's DOM/ES lib, so the capability is
// declared here and feature-detected below rather than assumed. Narrow on purpose: nothing else about Locale
// is being redeclared, so a lib that grows the method later simply satisfies this.
type LocaleWithZones = Intl.Locale & { getTimeZones?: () => readonly string[] };

export const countryLocale = (code: string): CountryLocale => {
    const cc = code.toUpperCase();
    let timezone = PRINCIPAL_ZONE[cc];
    let language = "en";
    try {
        const locale: LocaleWithZones = new Intl.Locale(`und-${cc}`);
        if (timezone === undefined) {
            // getTimeZones() on a region-only locale returns that region's zones; the first is ICU's canonical
            // one and, for the single-zone countries that aren't in the table above, the only one.
            timezone = locale.getTimeZones?.()[0];
        }
        language = locale.maximize().language;
    } catch {
        // An unknown code: keep the UTC/English default rather than fail a browser launch over a label.
    }
    const primary = `${language}-${cc}`;
    return {
        timezone: timezone ?? "Etc/UTC",
        locale: primary,
        languages: language === "en" ? [primary, "en"] : [primary, language, "en"],
    };
};

/* The baked fallback catalogs live in the CONTRACT, not here, because the add form's country picker needs the
 * same lists and a second copy would let the picker offer a country the driver cannot dial. Re-exported under
 * this module's names so every driver keeps importing "what a country means" from one place. See
 * TOR_EXIT_COUNTRIES in the contract for what these are and why they are labelled as not-live when used. */
export const TOR_FALLBACK = TOR_EXIT_COUNTRIES;
export const VPNGATE_FALLBACK = VPNGATE_EXIT_COUNTRIES;

// Countries → ranked ExitPoints, from a bare per-country server count. Shared by every driver that builds its
// catalog by tallying (VPN Gate's CSV, the pasted WireGuard confs), so ranking and naming are defined once.
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
