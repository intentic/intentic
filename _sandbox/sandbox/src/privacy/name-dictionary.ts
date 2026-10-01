import {
    type PersonalDataClass,
    PRIVACY_DICTIONARY_SAMPLE_MAX,
    type PrivacyDictionary,
    type PrivacyNameList,
    type PrivacyNameLookup,
    type PrivacyNameWord,
} from "@intentic/sandbox-contract";
import { AMBIGUOUS_EN, AMBIGUOUS_PL } from "./detect/data/ambiguous.js";
import { FIRST_NAMES_PL, FIRST_NAMES_PL_RARE } from "./detect/data/first-names-pl.js";
import { FIRST_NAMES_EN, SURNAMES_EN } from "./detect/data/names-en.js";
import { SURNAMES_PL } from "./detect/data/surnames-pl.js";
import {
    DIMINUTIVES_PL,
    NEVER_NAMES,
    NICKNAMES_EN,
    TITLE_ABBREVIATIONS_EN,
    TITLE_ABBREVIATIONS_PL,
    TITLES_EN,
    TITLES_PL,
} from "./detect/data/vocabulary.js";
import { detectPersonalData } from "./detect/detect.js";
import { wordInfo } from "./detect/lexicon.js";

// The dictionary the shield finds names by, as the owner can read it: each list it holds, how many words, where they
// come from, and, for a word, which lists hold it and whether it would be found. The lists themselves are the detector's
// own (detect/data/), read here, never copied, so what this says is what the detector does.

interface ListSource {
    readonly list: Omit<PrivacyNameList, "count">;
    readonly words: string;
}

const PESEL_FIRST_NAMES = {
    source: "PESEL register: first names borne by living people (Ministerstwo Cyfryzacji, dane.gov.pl)",
    url: "https://dane.gov.pl/pl/dataset/1667",
    license: "CC0 1.0",
} as const;
const HAND_WRITTEN = { source: "Written by hand alongside the registers" } as const;

const SOURCES: readonly ListSource[] = [
    {
        list: { id: "first-names-pl", kind: "first-name", languages: ["pl"], matching: "inflected", ...PESEL_FIRST_NAMES },
        words: FIRST_NAMES_PL,
    },
    {
        list: { id: "first-names-pl-rare", kind: "first-name", languages: ["pl"], matching: "as-written", ...PESEL_FIRST_NAMES },
        words: FIRST_NAMES_PL_RARE,
    },
    { list: { id: "diminutives-pl", kind: "first-name", languages: ["pl"], matching: "inflected", ...HAND_WRITTEN }, words: DIMINUTIVES_PL },
    {
        list: {
            id: "surnames-pl",
            kind: "surname",
            languages: ["pl"],
            matching: "inflected",
            source: "PESEL register: the most frequent surnames (Ministerstwo Cyfryzacji, dane.gov.pl)",
            url: "https://dane.gov.pl/pl/dataset/1681",
            license: "CC0 1.0",
        },
        words: SURNAMES_PL,
    },
    {
        list: {
            id: "first-names-en",
            kind: "first-name",
            languages: ["en"],
            matching: "as-written",
            source: "US Social Security Administration baby names since 1950",
            url: "https://www.ssa.gov/oact/babynames/limits.html",
            license: "Public domain",
        },
        words: FIRST_NAMES_EN,
    },
    { list: { id: "nicknames-en", kind: "first-name", languages: ["en"], matching: "as-written", ...HAND_WRITTEN }, words: NICKNAMES_EN },
    {
        list: {
            id: "surnames-en",
            kind: "surname",
            languages: ["en"],
            matching: "as-written",
            source: "US Census Bureau, surnames of the 2000 census",
            url: "https://www.census.gov/topics/population/genealogy/data/2000_surnames.html",
            license: "Public domain",
        },
        words: SURNAMES_EN,
    },
    { list: { id: "ambiguous-pl", kind: "ambiguous", languages: ["pl"], matching: "as-written", ...HAND_WRITTEN }, words: AMBIGUOUS_PL },
    { list: { id: "ambiguous-en", kind: "ambiguous", languages: ["en"], matching: "as-written", ...HAND_WRITTEN }, words: AMBIGUOUS_EN },
    {
        list: { id: "titles-pl", kind: "title", languages: ["pl"], matching: "as-written", ...HAND_WRITTEN },
        words: `${TITLES_PL} ${TITLE_ABBREVIATIONS_PL}`,
    },
    { list: { id: "titles-en", kind: "title", languages: ["en"], matching: "as-written", ...HAND_WRITTEN }, words: `${TITLES_EN} ${TITLE_ABBREVIATIONS_EN}` },
    { list: { id: "never-names", kind: "never", languages: ["pl", "en"], matching: "as-written", ...HAND_WRITTEN }, words: NEVER_NAMES },
];

interface Built {
    readonly lists: readonly PrivacyNameList[];
    readonly totals: PrivacyDictionary["totals"];
    // Every word of every list, sorted, with the lists holding it.
    readonly words: readonly { readonly word: string; readonly lists: readonly string[] }[];
}

// Built on first ask: tens of thousands of words, nothing a sandbox that never opens the page should pay for.
let built: Built | undefined;
const dictionary = (): Built => {
    if (built !== undefined) {
        return built;
    }
    const holders = new Map<string, string[]>();
    const kinds = new Map<PrivacyNameList["kind"], Set<string>>();
    const lists = SOURCES.map(({ list, words }) => {
        const unique = new Set(
            words
                .split(/\s+/u)
                .map((word) => word.trim().toLowerCase())
                .filter((word) => word !== ""),
        );
        const ofKind = kinds.get(list.kind) ?? new Set<string>();
        kinds.set(list.kind, ofKind);
        for (const word of unique) {
            ofKind.add(word);
            const held = holders.get(word);
            if (held === undefined) {
                holders.set(word, [list.id]);
            } else {
                held.push(list.id);
            }
        }
        return { ...list, count: unique.size };
    });
    const words = [...holders].map(([word, held]) => ({ word, lists: held })).toSorted((a, b) => a.word.localeCompare(b.word, "pl"));
    built = { lists, totals: { firstNames: kinds.get("first-name")?.size ?? 0, surnames: kinds.get("surname")?.size ?? 0 }, words };
    return built;
};

// Written as a name is: each word's first letter capital, hyphenated parts too ("Skłodowska-Curie").
const asName = (text: string): string =>
    text
        .toLocaleLowerCase("pl")
        .replaceAll(/(^|[\s-])(\p{L})/gu, (_, before: string, letter: string) => `${before}${letter.toLocaleUpperCase("pl")}`);

const wordOf = (word: string): PrivacyNameWord => {
    const info = wordInfo(word);
    return { word, firstName: info.first, surname: info.surname, surnameForm: info.surnameForm, ambiguous: info.ambiguous, never: info.never };
};

// What the dictionary makes of a word or a full name: what the lists say of each word, and whether the whole, written
// as a name on its own, is masked by the dictionary (the detector with nothing else turned on).
export const lookUpName = (query: string): PrivacyNameLookup => {
    const text = asName(query.trim().replaceAll(/\s+/gu, " "));
    const found = detectPersonalData(text, { classes: new Set<PersonalDataClass>(["person-name"]) }).some(
        (span) => span.start === 0 && span.end === text.length,
    );
    return { text, found, words: text.split(" ").map(wordOf) };
};

// A word, or a name of a few: letters, apostrophes and hyphens, nothing a list could hold beyond that.
const NAME_LIKE = /^[\p{L}'-]+(?: [\p{L}'-]+){0,4}$/u;

// The lists, and for a query what it is as a name and, for one word, the listed words starting with it (alphabetically,
// at most a page).
export const nameDictionary = (query?: string): PrivacyDictionary => {
    const { lists, totals, words } = dictionary();
    const typed = query?.trim().replaceAll(/\s+/gu, " ") ?? "";
    if (!NAME_LIKE.test(typed)) {
        return { lists: [...lists], totals, matches: [] };
    }
    const prefix = typed.toLocaleLowerCase("pl");
    const matches = prefix.includes(" ")
        ? []
        : words
              .filter((entry) => entry.word.startsWith(prefix))
              .slice(0, PRIVACY_DICTIONARY_SAMPLE_MAX)
              .map((entry) => ({ word: entry.word, lists: [...entry.lists] }));
    return { lists: [...lists], totals, matches, lookup: lookUpName(typed) };
};
