// The languages the app ships, and the rule for picking one. No Vue and no vue-i18n here on purpose: index.html's
// pre-paint script re-implements `negotiate` in five lines of ES5, and bootLocale.test.ts asserts the two agree —
// that check can only read a module with no runtime behind it.

/** A shipped language: its BCP-47 tag is the key, its endonym is what the picker shows. */
export interface LocaleEntry {
    /** The language's name in itself, never translated — a reader looking for their language reads it in their own. */
    readonly endonym: string;
    /** What `Intl` and `<html lang>` are handed. */
    readonly tag: string;
}

// Ordered the way the picker lists them: the source locale first, the rest alphabetical by tag.
export const LOCALES = {
    en: { endonym: `English`, tag: `en` },
    de: { endonym: `Deutsch`, tag: `de` },
    es: { endonym: `Español`, tag: `es` },
    fr: { endonym: `Français`, tag: `fr` },
    pl: { endonym: `Polski`, tag: `pl` },
} as const satisfies Record<string, LocaleEntry>;

export type Locale = keyof typeof LOCALES;

/** Every other locale is a lazy chunk; this one is compiled in, because it is also the fallback for a missing key. */
export const BASE_LOCALE = `en` satisfies Locale;

export const LOCALE_CODES = Object.keys(LOCALES) as readonly Locale[];

export const isLocale = (value: unknown): value is Locale => typeof value === `string` && Object.hasOwn(LOCALES, value);

// The browser's list is region-tagged ("pl-PL", "en-GB") and we ship base languages only, so a tag matches on its
// primary subtag. First match wins, which is what `navigator.languages` order already means.
export const negotiate = (preferred: readonly string[]): Locale => {
    for (const tag of preferred) {
        const language = tag.toLowerCase().split(`-`)[0];
        if (isLocale(language)) {
            return language;
        }
    }
    return BASE_LOCALE;
};

/** The localStorage key the pre-paint script and `definePreference` both read; `ui-` is the preference namespace. */
export const LOCALE_KEY = `ui-locale`;
