import type { PrivacyNameListKind, PrivacyNameMatching } from "@intentic/sandbox-contract/schemas/privacy";
import { AMBIGUOUS_EN, AMBIGUOUS_PL } from "./data/ambiguous.js";
import { COMMON_WORDS } from "./data/common-words.js";
import { FIRST_NAMES_PL, FIRST_NAMES_PL_RARE } from "./data/first-names-pl.js";
import { FIRST_NAMES_EN, SURNAMES_EN } from "./data/names-en.js";
import { SURNAMES_PL } from "./data/surnames-pl.js";
import {
    DIMINUTIVES_PL,
    NEVER_NAMES,
    NICKNAMES_EN,
    THING_NOUNS,
    TITLE_ABBREVIATIONS_EN,
    TITLE_ABBREVIATIONS_PL,
    TITLES_EN,
    TITLES_PL,
} from "./data/vocabulary.js";

// The name lists the owner can read and switch off, each with where its words come from and where in the lexicon they
// go: the one registry the lexicon is built from and the privacy page describes, so what the page says is what the
// detector reads. The word lists that only steer the rules (roles, place words, the -ski adjectives, ordinary English
// words) are no list of names and are always read.

// The sets of the lexicon a list fills (lexicon.ts).
export type LexiconSlot =
    | "declinedFirst"
    | "plainFirst"
    | "declinedSurnames"
    | "plainSurnames"
    | "ambiguous"
    | "never"
    | "things"
    | "titles"
    | "abbreviations"
    | "titlesEn"
    | "abbreviationsEn";

export interface NameListSource {
    readonly id: string;
    readonly kind: PrivacyNameListKind;
    readonly languages: readonly ("pl" | "en" | "multi")[];
    readonly matching: PrivacyNameMatching;
    readonly source: string;
    readonly url?: string;
    readonly license?: string;
    // Each set it fills, with its words as written there (separated by whitespace).
    readonly parts: readonly (readonly [LexiconSlot, string])[];
}

const PESEL_FIRST_NAMES = {
    source: "PESEL register: first names borne by living people (Ministerstwo Cyfryzacji, dane.gov.pl)",
    url: "https://dane.gov.pl/pl/dataset/1667",
    license: "CC0 1.0",
} as const;
const HAND_WRITTEN = { source: "Written by hand alongside the registers" } as const;

export const NAME_LISTS: readonly NameListSource[] = [
    {
        id: "first-names-pl",
        kind: "first-name",
        languages: ["pl"],
        matching: "inflected",
        ...PESEL_FIRST_NAMES,
        parts: [["declinedFirst", FIRST_NAMES_PL]],
    },
    {
        id: "first-names-pl-rare",
        kind: "first-name",
        languages: ["pl"],
        matching: "as-written",
        ...PESEL_FIRST_NAMES,
        parts: [["plainFirst", FIRST_NAMES_PL_RARE]],
    },
    {
        id: "diminutives-pl",
        kind: "first-name",
        languages: ["pl"],
        matching: "inflected",
        ...HAND_WRITTEN,
        parts: [["declinedFirst", DIMINUTIVES_PL]],
    },
    {
        id: "surnames-pl",
        kind: "surname",
        languages: ["pl"],
        matching: "inflected",
        source: "PESEL register: the most frequent surnames (Ministerstwo Cyfryzacji, dane.gov.pl)",
        url: "https://dane.gov.pl/pl/dataset/1681",
        license: "CC0 1.0",
        parts: [["declinedSurnames", SURNAMES_PL]],
    },
    {
        id: "first-names-en",
        kind: "first-name",
        languages: ["en"],
        matching: "as-written",
        source: "US Social Security Administration baby names since 1950",
        url: "https://www.ssa.gov/oact/babynames/limits.html",
        license: "Public domain",
        parts: [["plainFirst", FIRST_NAMES_EN]],
    },
    { id: "nicknames-en", kind: "first-name", languages: ["en"], matching: "as-written", ...HAND_WRITTEN, parts: [["plainFirst", NICKNAMES_EN]] },
    {
        id: "surnames-en",
        kind: "surname",
        languages: ["en"],
        matching: "as-written",
        source: "US Census Bureau, surnames of the 2000 census",
        url: "https://www.census.gov/topics/population/genealogy/data/2000_surnames.html",
        license: "Public domain",
        parts: [["plainSurnames", SURNAMES_EN]],
    },
    { id: "ambiguous-pl", kind: "ambiguous", languages: ["pl"], matching: "as-written", ...HAND_WRITTEN, parts: [["ambiguous", AMBIGUOUS_PL]] },
    { id: "ambiguous-en", kind: "ambiguous", languages: ["en"], matching: "as-written", ...HAND_WRITTEN, parts: [["ambiguous", AMBIGUOUS_EN]] },
    {
        id: "common-words",
        kind: "ambiguous",
        languages: ["multi"],
        matching: "as-written",
        source: "Leipzig Corpora Collection: names written as ordinary lowercase words in the corpora of 33 languages",
        url: "https://wortschatz.uni-leipzig.de/en/download",
        license: "CC BY",
        parts: [["ambiguous", COMMON_WORDS]],
    },
    {
        id: "titles-pl",
        kind: "title",
        languages: ["pl"],
        matching: "as-written",
        ...HAND_WRITTEN,
        parts: [
            ["titles", TITLES_PL],
            ["abbreviations", TITLE_ABBREVIATIONS_PL],
        ],
    },
    {
        id: "titles-en",
        kind: "title",
        languages: ["en"],
        matching: "as-written",
        ...HAND_WRITTEN,
        parts: [
            ["titlesEn", TITLES_EN],
            ["abbreviationsEn", TITLE_ABBREVIATIONS_EN],
        ],
    },
    {
        id: "never-names",
        kind: "never",
        languages: ["pl", "en"],
        matching: "as-written",
        ...HAND_WRITTEN,
        parts: [
            ["never", NEVER_NAMES],
            ["things", THING_NOUNS],
        ],
    },
];

export const NAME_LIST_IDS: ReadonlySet<string> = new Set(NAME_LISTS.map((list) => list.id));

// A list's words as one set of lowercase words, as the privacy page counts and browses them.
export const listWords = (list: Pick<NameListSource, "parts">): Set<string> =>
    new Set(
        list.parts
            .flatMap(([, words]) => words.split(/\s+/u))
            .map((word) => word.trim().toLowerCase())
            .filter((word) => word !== ""),
    );
