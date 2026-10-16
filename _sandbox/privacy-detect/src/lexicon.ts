import type { PrivacyNameListKind, PrivacyNameMatching } from "@intentic/sandbox-contract/schemas/privacy";
import { ORDINARY_WORDS_EN } from "./data/ordinary-words.js";
import { NOT_SURNAMES, PLACE_WORDS, ROLES_PL } from "./data/vocabulary.js";
import { lemmaCandidates } from "./inflection.js";
import { type LexiconSlot, NAME_LISTS } from "./name-lists.js";

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
    // An ordinary English word the name lists know nothing about ("crew", "haven"): no name, though no list says it is
    // never one. Only a name standing alone (standalone.ts) asks, since elsewhere an unlisted capitalized word after a
    // title or under a name field is somebody's surname.
    readonly ordinary: boolean;
    // Never part of a name: a function word, an institution, a title, an adjective of a place, a noun in -ska.
    readonly never: boolean;
    // A noun of an institution, a place or a thing, which makes a name before it a thing's: "Victoria Station".
    readonly thing: boolean;
}

// An owner's own list as the lexicon reads it (policy.dictionary.lists).
export interface OwnWords {
    readonly kind: PrivacyNameListKind;
    readonly matching: PrivacyNameMatching;
    readonly words: readonly string[];
}

// What a lexicon is built from: the built-in lists less those switched off, and the owner's own.
export interface LexiconConfig {
    readonly off?: Iterable<string>;
    readonly own?: readonly OwnWords[];
}

// What the lists say about a word, and about the capitalized word after it, under one configuration. Each holds its own
// cache, so two policies never read each other's answers.
export interface Lexicon {
    readonly info: (word: string) => WordInfo;
    readonly announcer: (word: string, dotted: boolean) => Announcer | undefined;
}

const words = (...lists: readonly string[]): Set<string> => new Set(lists.flatMap((list) => list.split(/\s+/)).filter((word) => word !== ""));

// Where an own list's words go. A title written with a dot is an abbreviation, which only counts with its dot.
const ownSlot = (kind: PrivacyNameListKind, matching: PrivacyNameMatching, word: string): LexiconSlot => {
    switch (kind) {
        case "first-name":
            return matching === "inflected" ? "declinedFirst" : "plainFirst";
        case "surname":
            return matching === "inflected" ? "declinedSurnames" : "plainSurnames";
        case "ambiguous":
            return "ambiguous";
        case "title":
            return word.endsWith(".") ? "abbreviations" : "titles";
        case "never":
            return "never";
    }
};

const buildSets = ({ off, own = [] }: LexiconConfig) => {
    const skipped = new Set(off);
    const texts = new Map<LexiconSlot, string[]>();
    const add = (slot: LexiconSlot, text: string): void => {
        const held = texts.get(slot);
        if (held === undefined) {
            texts.set(slot, [text]);
        } else {
            held.push(text);
        }
    };
    for (const list of NAME_LISTS) {
        if (!skipped.has(list.id)) {
            for (const [slot, text] of list.parts) {
                add(slot, text);
            }
        }
    }
    // Lowercase, as the lexicon looks words up; one word each, whatever was pasted.
    for (const list of own) {
        for (const word of list.words.flatMap((each) => each.toLowerCase().split(/\s+/u))) {
            if (word !== "") {
                add(ownSlot(list.kind, list.matching, word), word);
            }
        }
    }
    const slot = (name: LexiconSlot): Set<string> => words(...(texts.get(name) ?? []));
    return {
        declinedFirst: slot("declinedFirst"),
        plainFirst: slot("plainFirst"),
        declinedSurnames: slot("declinedSurnames"),
        plainSurnames: slot("plainSurnames"),
        ambiguous: slot("ambiguous"),
        never: slot("never"),
        things: slot("things"),
        titles: slot("titles"),
        abbreviations: slot("abbreviations"),
        titlesEn: slot("titlesEn"),
        abbreviationsEn: slot("abbreviationsEn"),
        ordinary: words(ORDINARY_WORDS_EN),
        notSurnames: words(NOT_SURNAMES),
        roles: words(ROLES_PL),
        places: words(PLACE_WORDS),
    };
};

const STRONG_SUFFIX = /(?:[sc]ki|dzki|[sc]ka|dzka|wicz|czyk)$/u;
const WEAK_SUFFIX = /[aeiyu]k$/u;
// The forms those surnames take, read off the word as written rather than off guessed nominatives.
const STRONG_FORM = /(?:[sc]|dz)k(?:i|iego|iemu|im|ich|imi|a|iej|ą)$|(?:[sc]|dz)cy$|wicz(?:a|owi|em|u|owie|ów)?$|czyk(?:a|owi|iem|u|owie|ów)?$/u;

type Sets = ReturnType<typeof buildSets>;

// Words recur (a name down a column, a heading on every page), so each is analysed once. Cleared rather than evicted
// one by one when full: simpler, and a refill costs a fraction of a millisecond per thousand words.
const CACHE_LIMIT = 50_000;

const capitalize = (word: string): string => (word[0] ?? "").toUpperCase() + word.slice(1);

const analyse = (sets: Sets, lower: string): WordInfo => {
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
        ordinary: sets.ordinary.has(lower),
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

// What a word says about the capitalized word after it: an honorific (any word after it is a person), a title that is
// also a word (Miss, Lady, Sir: a person if the lists know the word, "Miss Italia" is a pageant), a role (a person if
// the word is a surname: "prezes Kowalski"), or a place word (not a person: "ulica Grodzka"). Polish ones in any case
// ("pan", "Pani", "prezes"), English ones capitalized, none in capitals ("DR Congo"). A dot after a whole word ends a
// sentence, so only abbreviations may carry one.
export type Announcer = "honorific" | "title" | "role" | "place";

const announce = (sets: Sets, word: string, dotted: boolean): Announcer | undefined => {
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

// Built on first use: some 28,000 entries, a few milliseconds, not worth paying for in a process that never masks.
const lazyLexicon = (config: LexiconConfig): Lexicon => {
    let sets: Sets | undefined;
    const cache = new Map<string, WordInfo>();
    const built = (): Sets => (sets ??= buildSets(config));
    return {
        info: (word) => {
            const lower = word.toLowerCase();
            let info = cache.get(lower);
            if (info === undefined) {
                if (cache.size >= CACHE_LIMIT) {
                    cache.clear();
                }
                info = analyse(built(), lower);
                cache.set(lower, info);
            }
            return info;
        },
        announcer: (word, dotted) => announce(built(), word, dotted),
    };
};

// The lists as they ship, every one of them on.
const BUILT_IN = lazyLexicon({});
export const builtInLexicon = (): Lexicon => BUILT_IN;

// A lexicon for one configuration; the built-in one when nothing is switched off and nothing added.
export const createLexicon = (config: LexiconConfig = {}): Lexicon => {
    const off = [...(config.off ?? [])];
    const own = (config.own ?? []).filter((list) => list.words.length > 0);
    return off.length === 0 && own.length === 0 ? BUILT_IN : lazyLexicon({ off, own });
};

export const wordInfo = (word: string, lexicon: Lexicon = BUILT_IN): WordInfo => lexicon.info(word);

export const announcerOf = (word: string, dotted: boolean, lexicon: Lexicon = BUILT_IN): Announcer | undefined => lexicon.announcer(word, dotted);
