import {
    type PersonalDataClass,
    PRIVACY_DICTIONARY_SAMPLE_MAX,
    type PrivacyDictionary,
    type PrivacyDictionaryPolicy,
    type PrivacyNameList,
    type PrivacyNameLookup,
    type PrivacyNameWord,
} from "@intentic/sandbox-contract/schemas/privacy";
import { detectPersonalData } from "@intentic/privacy-detect";
import { builtInLexicon, type Lexicon } from "@intentic/privacy-detect/lexicon";
import { listWords, NAME_LISTS } from "@intentic/privacy-detect/name-lists";
import { dictionaryLexicon } from "./policy-detector.js";

// The dictionary the shield finds names by, as the owner reads it and set it: each list it holds (the built-in ones and
// the owner's own), whether it is on, how many words, where they come from, and, for a word, which lists hold it and
// whether it would be found. The built-in lists are the detector's own registry (@intentic/privacy-detect name-lists),
// read here, never copied, and a lookup reads the lexicon the shield reads under the owner's policy, so what this says
// is what the detector does.

interface Held {
    readonly list: Omit<PrivacyNameList, "on">;
    readonly words: ReadonlySet<string>;
}

interface BuiltIn {
    readonly lists: readonly Held[];
    // Every word of every built-in list, sorted, with the lists holding it.
    readonly words: readonly { readonly word: string; readonly lists: readonly string[] }[];
}

// Built on first ask: tens of thousands of words, nothing a sandbox that never opens the page should pay for.
let builtIn: BuiltIn | undefined;
const builtInLists = (): BuiltIn => {
    if (builtIn !== undefined) {
        return builtIn;
    }
    const lists = NAME_LISTS.map(({ parts, languages, ...list }) => {
        const words = listWords({ parts });
        return { list: { ...list, languages: [...languages], count: words.size }, words };
    });
    const holders = new Map<string, string[]>();
    for (const { list, words } of lists) {
        for (const word of words) {
            holders.set(word, [...(holders.get(word) ?? []), list.id]);
        }
    }
    const words = [...holders].map(([word, held]) => ({ word, lists: held })).toSorted((a, b) => a.word.localeCompare(b.word, "pl"));
    builtIn = { lists, words };
    return builtIn;
};

const OWN_SOURCE = "The owner's own list";

const ownLists = (config: PrivacyDictionaryPolicy): (Held & { readonly on: boolean })[] =>
    config.lists.map((own) => {
        const words = new Set(own.words.flatMap((word) => word.toLowerCase().split(/\s+/u)).filter((word) => word !== ""));
        return {
            list: {
                id: own.id,
                kind: own.kind,
                languages: [],
                // Only names inflect: a title or an ordinary word is matched as written whatever the list says.
                matching: own.kind === "first-name" || own.kind === "surname" ? own.matching : "as-written",
                count: words.size,
                source: OWN_SOURCE,
                own: true,
                title: own.title,
            },
            words,
            on: own.on,
        };
    });

// Written as a name is: each word's first letter capital, hyphenated parts too ("Skłodowska-Curie").
const asName = (text: string): string =>
    text
        .toLocaleLowerCase("pl")
        .replaceAll(/(^|[\s-])(\p{L})/gu, (_, before: string, letter: string) => `${before}${letter.toLocaleUpperCase("pl")}`);

const wordOf = (word: string, lexicon: Lexicon): PrivacyNameWord => {
    const info = lexicon.info(word);
    return { word, firstName: info.first, surname: info.surname, surnameForm: info.surnameForm, ambiguous: info.ambiguous, never: info.never };
};

// What the dictionary makes of a word or a full name: what the lists say of each word, and whether the whole, written
// as a name on its own, is masked by the dictionary (the detector with nothing else turned on).
export const lookUpName = (query: string, lexicon: Lexicon = builtInLexicon()): PrivacyNameLookup => {
    const text = asName(query.trim().replaceAll(/\s+/gu, " "));
    const found = detectPersonalData(text, { classes: new Set<PersonalDataClass>(["person-name"]), lexicon }).some(
        (span) => span.start === 0 && span.end === text.length,
    );
    return { text, found, words: text.split(" ").map((word) => wordOf(word, lexicon)) };
};

// A word, or a name of a few: letters, apostrophes and hyphens, nothing a list could hold beyond that.
const NAME_LIKE = /^[\p{L}'-]+(?: [\p{L}'-]+){0,4}$/u;

// Distinct words across the lists of a kind that are on.
const distinct = (lists: readonly (Held & { readonly on: boolean })[], kind: PrivacyNameList["kind"]): number =>
    new Set(lists.filter((held) => held.on && held.list.kind === kind).flatMap((held) => [...held.words])).size;

// The listed words starting with `prefix`, alphabetically, at most a page: the built-in index, and the owner's lists.
const startingWith = (prefix: string, own: readonly Held[]): PrivacyDictionary["matches"] => {
    const found = new Map<string, string[]>();
    for (const entry of builtInLists().words) {
        if (found.size >= PRIVACY_DICTIONARY_SAMPLE_MAX) {
            break;
        }
        if (entry.word.startsWith(prefix)) {
            found.set(entry.word, [...entry.lists]);
        }
    }
    for (const held of own) {
        for (const word of held.words) {
            if (word.startsWith(prefix)) {
                found.set(word, [...(found.get(word) ?? []), held.list.id]);
            }
        }
    }
    return [...found]
        .map(([word, lists]) => ({ word, lists }))
        .toSorted((a, b) => a.word.localeCompare(b.word, "pl"))
        .slice(0, PRIVACY_DICTIONARY_SAMPLE_MAX);
};

// The lists with whether each is on, and for a query what it is as a name and, for one word, the listed words starting
// with it (alphabetically, at most a page).
// `lexicon` is the one the shield reads under `config`, when the caller holds it already (policy-detector.ts).
export const nameDictionary = (
    query?: string,
    config: PrivacyDictionaryPolicy = { off: [], lists: [] },
    lexicon: Lexicon = dictionaryLexicon(config),
): PrivacyDictionary => {
    const off = new Set(config.off);
    const own = ownLists(config);
    const all = [...builtInLists().lists.map((held) => ({ ...held, on: !off.has(held.list.id) })), ...own];
    const lists = all.map(({ list, on }) => ({ ...list, on }));
    const totals = { firstNames: distinct(all, "first-name"), surnames: distinct(all, "surname") };
    const typed = query?.trim().replaceAll(/\s+/gu, " ") ?? "";
    if (!NAME_LIKE.test(typed)) {
        return { lists, totals, matches: [] };
    }
    const prefix = typed.toLocaleLowerCase("pl");
    const matches = prefix.includes(" ") ? [] : startingWith(prefix, own);
    return { lists, totals, matches, lookup: lookUpName(typed, lexicon) };
};
