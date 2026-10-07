import { AMBIGUOUS_EN, AMBIGUOUS_PL } from "./data/ambiguous.js";
import { COMMON_WORDS } from "./data/common-words.js";
import { FIRST_NAMES_PL, FIRST_NAMES_PL_RARE } from "./data/first-names-pl.js";
import { FIRST_NAMES_EN, SURNAMES_EN } from "./data/names-en.js";
import { SURNAMES_PL } from "./data/surnames-pl.js";
import {
    DIMINUTIVES_PL,
    NEVER_NAMES,
    NICKNAMES_EN,
    NOT_SURNAMES,
    PLACE_WORDS,
    ROLES_PL,
    THING_NOUNS,
    TITLE_ABBREVIATIONS_EN,
    TITLE_ABBREVIATIONS_PL,
    TITLES_EN,
    TITLES_PL,
} from "./data/vocabulary.js";
import { lemmaCandidates } from "./inflection.js";

// What the name lists say about one word, whatever its case.
export interface WordInfo {
    // A first name: a common Polish one (or a familiar form) in any inflected form, a rarer or English one as written.
    readonly first: boolean;
    // A surname from the registers: a Polish one in any inflected form, an English one as written.
    readonly surname: boolean;
    // The suffix of the listed surname it is a form of: strong for -ski/-cki/-dzki/-wicz/-czyk, weak for
    // -ak/-ek/-ik/-yk/-uk. Taken from the listed lemma itself, so "Zyska" (a form of the listed "Zysk") is not -ska.
    readonly surnameSuffix: "strong" | "weak" | undefined;
    // Written as a form of a -ski, -cki, -dzki, -wicz or -czyk surname, listed or not: "Brzęczyszczykiewicza".
    readonly surnameForm: boolean;
    // The word as written is an ordinary word too, in Polish, English or another language, so it proves nothing on its
    // own and is no surname a first name can be paired with.
    readonly ambiguous: boolean;
    // Never part of a name: a function word, an institution, a title, an adjective of a place, a noun in -ska.
    readonly never: boolean;
    // A noun of an institution, a place or a thing, which makes a name before it a thing's: "Victoria Station".
    readonly thing: boolean;
}

interface Lexicon {
    readonly declinedFirst: ReadonlySet<string>;
    readonly plainFirst: ReadonlySet<string>;
    readonly declinedSurnames: ReadonlySet<string>;
    readonly plainSurnames: ReadonlySet<string>;
    readonly ambiguous: ReadonlySet<string>;
    readonly never: ReadonlySet<string>;
    readonly things: ReadonlySet<string>;
    readonly notSurnames: ReadonlySet<string>;
    readonly titles: ReadonlySet<string>;
    readonly abbreviations: ReadonlySet<string>;
    readonly titlesEn: ReadonlySet<string>;
    readonly abbreviationsEn: ReadonlySet<string>;
    readonly roles: ReadonlySet<string>;
    readonly places: ReadonlySet<string>;
}

const words = (...lists: readonly string[]): Set<string> => new Set(lists.flatMap((list) => list.split(/\s+/)).filter((word) => word !== ""));

// Built on first use: some 15,000 entries, a few milliseconds, not worth paying for in a process that never masks.
let built: Lexicon | undefined;
const lexicon = (): Lexicon => {
    built ??= {
        declinedFirst: words(FIRST_NAMES_PL, DIMINUTIVES_PL),
        plainFirst: words(FIRST_NAMES_PL_RARE, FIRST_NAMES_EN, NICKNAMES_EN),
        declinedSurnames: words(SURNAMES_PL),
        plainSurnames: words(SURNAMES_EN),
        ambiguous: words(AMBIGUOUS_EN, AMBIGUOUS_PL, COMMON_WORDS),
        never: words(NEVER_NAMES),
        things: words(THING_NOUNS),
        notSurnames: words(NOT_SURNAMES),
        titles: words(TITLES_PL),
        abbreviations: words(TITLE_ABBREVIATIONS_PL),
        titlesEn: words(TITLES_EN),
        abbreviationsEn: words(TITLE_ABBREVIATIONS_EN),
        roles: words(ROLES_PL),
        places: words(PLACE_WORDS),
    };
    return built;
};

const STRONG_SUFFIX = /(?:[sc]ki|dzki|[sc]ka|dzka|wicz|czyk)$/u;
const WEAK_SUFFIX = /[aeiyu]k$/u;
// The forms those surnames take, read off the word as written rather than off guessed nominatives.
const STRONG_FORM = /(?:[sc]|dz)k(?:i|iego|iemu|im|ich|imi|a|iej|ą)$|(?:[sc]|dz)cy$|wicz(?:a|owi|em|u|owie|ów)?$|czyk(?:a|owi|iem|u|owie|ów)?$/u;

// Words recur (a name down a column, a heading on every page), so each is analysed once. Cleared rather than evicted
// one by one when full: simpler, and a refill costs a fraction of a millisecond per thousand words.
const CACHE_LIMIT = 50_000;
const cache = new Map<string, WordInfo>();

const capitalize = (word: string): string => (word[0] ?? "").toUpperCase() + word.slice(1);

const analyse = (lower: string): WordInfo => {
    const sets = lexicon();
    // First names are matched in the singular only: "Piotrkowie" is the town, not a family of Piotreks.
    const singular = lemmaCandidates(lower, false);
    const all = lemmaCandidates(lower, true);
    const first = singular.some((lemma) => sets.declinedFirst.has(lemma)) || sets.plainFirst.has(lower);
    const listed = all.filter((lemma) => sets.declinedSurnames.has(lemma));
    const strong = listed.some((lemma) => STRONG_SUFFIX.test(lemma));
    const weak = !strong && listed.some((lemma) => WEAK_SUFFIX.test(lemma));
    return {
        first,
        surname: listed.length > 0 || sets.plainSurnames.has(lower),
        surnameSuffix: strong ? "strong" : weak ? "weak" : undefined,
        surnameForm: STRONG_FORM.test(lower),
        ambiguous: sets.ambiguous.has(lower),
        thing: sets.things.has(lower),
        // A title is not part of the name it announces: "Pan" in "Pan Tadeusz", "Mr" in "Mr. Wickham".
        never:
            sets.never.has(lower) ||
            sets.things.has(lower) ||
            sets.titles.has(lower) ||
            sets.abbreviations.has(lower) ||
            sets.titlesEn.has(capitalize(lower)) ||
            sets.abbreviationsEn.has(capitalize(lower)) ||
            all.some((lemma) => sets.notSurnames.has(lemma)),
    };
};

export const wordInfo = (word: string): WordInfo => {
    const lower = word.toLowerCase();
    let info = cache.get(lower);
    if (info === undefined) {
        if (cache.size >= CACHE_LIMIT) {
            cache.clear();
        }
        info = analyse(lower);
        cache.set(lower, info);
    }
    return info;
};

// What a word says about the capitalized word after it: an honorific (any word after it is a person), a title that is
// also a word (Miss, Lady, Sir: a person if the lists know the word, "Miss Italia" is a pageant), a role (a person if
// the word is a surname: "prezes Kowalski"), or a place word (not a person: "ulica Grodzka"). Polish ones in any case
// ("pan", "Pani", "prezes"), English ones capitalized, none in capitals ("DR Congo"). A dot after a whole word ends a
// sentence, so only abbreviations may carry one.
export type Announcer = "honorific" | "title" | "role" | "place";

export const announcerOf = (word: string, dotted: boolean): Announcer | undefined => {
    const sets = lexicon();
    const lower = word.toLowerCase();
    if (word.length > 1 && word === word.toUpperCase()) {
        return undefined;
    }
    if (dotted) {
        if (sets.abbreviations.has(`${lower}.`) || sets.abbreviations.has(lower) || sets.abbreviationsEn.has(word)) {
            return "honorific";
        }
        return sets.roles.has(`${lower}.`) ? "role" : sets.places.has(`${lower}.`) ? "place" : undefined;
    }
    if (sets.titles.has(lower) || sets.abbreviations.has(lower) || sets.abbreviationsEn.has(word)) {
        return "honorific";
    }
    if (sets.titlesEn.has(word)) {
        return "title";
    }
    return sets.roles.has(lower) ? "role" : sets.places.has(lower) ? "place" : undefined;
};
