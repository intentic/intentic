// Which form of a vue-i18n plural each Android quantity shows. The web picks a form by index, with vue-i18n's default
// rule or a language's own (_editor/ui/src/i18n/i18n.ts, `pluralRules`); Android picks by CLDR category (one, few,
// many, other). So each category a language has is given one sample count, and the web's own rule says which form that
// count gets: the mapping is derived from the rules the web runs, never written per language by hand.

// vue-i18n 11's default (core-base's pluralDefault): `one | other`, or `zero | one | other` with three forms.
export const vueDefault = (choice, length) => (length === 2 ? (Math.abs(choice) === 1 ? 0 : 1) : Math.min(Math.abs(choice), 2));

// Mirrors of i18n.ts's pluralRules: plurals.test.mjs reads that file and fails when these drift from it.
export const RULES = {
    pl: (choice, length) => {
        const count = Math.abs(choice);
        if (count === 1) {
            return 0;
        }
        if (length < 3) {
            return 1;
        }
        const tens = count % 10;
        const hundreds = count % 100;
        return tens >= 2 && tens <= 4 && !(hundreds >= 12 && hundreds <= 14) ? 1 : 2;
    },
    fr: (choice) => (Math.abs(choice) <= 1 ? 0 : 1),
};

// A count in each CLDR category Android's resources resolve for these languages, from the CLDR plural rules. `other` in
// Polish is the fractions; `many` in Spanish and French is a round million.
const SAMPLES = {
    en: { one: 1, other: 2 },
    de: { one: 1, other: 2 },
    es: { one: 1, many: 1_000_000, other: 2 },
    fr: { one: 1, many: 1_000_000, other: 2 },
    pl: { one: 1, few: 2, many: 5, other: 1.5 },
};

export const LOCALES = Object.keys(SAMPLES);

/** `[[quantity, formIndex], …]` for a plural of `length` forms in `locale`. */
export const quantities = (locale, length, key) => {
    const rule = RULES[locale] ?? vueDefault;
    const picked = Object.entries(SAMPLES[locale]).map(([quantity, count]) => [quantity, rule(count, length)]);
    const unused = [...Array.from({ length }).keys()].filter((index) => !picked.some(([, form]) => form === index));
    if (unused.length > 0) {
        // English's three-form `zero | one | other`, say: Android never asks for `zero` in English, so form 0 would vanish.
        throw new Error(`${key} (${locale}): Android never shows form ${unused.join(`, `)} of its ${length}`);
    }
    return picked;
};
