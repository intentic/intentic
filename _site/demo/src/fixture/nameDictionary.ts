import { PRIVACY_DICTIONARY_SAMPLE_MAX, type PrivacyDictionary, type PrivacyNameList, type PrivacyNameWord } from "@intentic/sandbox-contract";

// The privacy shield's name dictionary as a fresh sandbox reports it: the daemon's own lists with their real counts and
// sources (src/privacy/name-dictionary.ts), and a few words of each, so the search has something to browse and a name
// typed into it gets an answer of the same shape the daemon gives. The daemon judges a name with its detector; this
// judges by the sample alone.

const PESEL_FIRST = { source: `PESEL register: first names borne by living people`, url: `https://dane.gov.pl/pl/dataset/1667`, license: `CC0 1.0` };
const HAND = { source: `Written by hand alongside the registers` };

const LISTS: readonly (PrivacyNameList & { readonly sample: string })[] = [
    { id: `first-names-pl`, kind: `first-name`, languages: [`pl`], matching: `inflected`, count: 717, ...PESEL_FIRST, sample: `anna maria katarzyna małgorzata agnieszka jan andrzej piotr krzysztof tomasz paweł michał róża` },
    { id: `first-names-pl-rare`, kind: `first-name`, languages: [`pl`], matching: `as-written`, count: 1_091, ...PESEL_FIRST, sample: `ana vera nika william theo` },
    { id: `diminutives-pl`, kind: `first-name`, languages: [`pl`], matching: `inflected`, count: 85, ...HAND, sample: `ania kasia tomek bartek` },
    {
        id: `surnames-pl`,
        kind: `surname`,
        languages: [`pl`],
        matching: `inflected`,
        count: 10_613,
        source: `PESEL register: the most frequent surnames`,
        url: `https://dane.gov.pl/pl/dataset/1681`,
        license: `CC0 1.0`,
        sample: `nowak kowalski kowalska kowal kowalczyk kowalczuk kowalewski wiśniewski wiśniewska wójcik kamiński lewandowski zieliński szymański woźniak`,
    },
    {
        id: `first-names-en`,
        kind: `first-name`,
        languages: [`en`],
        matching: `as-written`,
        count: 481,
        source: `US Social Security Administration baby names since 1950`,
        url: `https://www.ssa.gov/oact/babynames/limits.html`,
        license: `Public domain`,
        sample: `james john robert mary patricia jennifer`,
    },
    { id: `nicknames-en`, kind: `first-name`, languages: [`en`], matching: `as-written`, count: 22, ...HAND, sample: `will bob liz kate` },
    {
        id: `surnames-en`,
        kind: `surname`,
        languages: [`en`],
        matching: `as-written`,
        count: 933,
        source: `US Census Bureau, surnames of the 2000 census`,
        url: `https://www.census.gov/topics/population/genealogy/data/2000_surnames.html`,
        license: `Public domain`,
        sample: `smith johnson williams brown jones`,
    },
    { id: `ambiguous-pl`, kind: `ambiguous`, languages: [`pl`], matching: `as-written`, count: 269, ...HAND, sample: `kowal róża lew wiktoria` },
    { id: `ambiguous-en`, kind: `ambiguous`, languages: [`en`], matching: `as-written`, count: 308, ...HAND, sample: `will mark grace may` },
    { id: `titles-pl`, kind: `title`, languages: [`pl`], matching: `as-written`, count: 34, ...HAND, sample: `pan pani dr prof.` },
    { id: `titles-en`, kind: `title`, languages: [`en`], matching: `as-written`, count: 11, ...HAND, sample: `mr mrs dr prof` },
    { id: `never-names`, kind: `never`, languages: [`pl`, `en`], matching: `as-written`, count: 318, ...HAND, sample: `the and uniwersytet ulica` },
];

const holders = (word: string): PrivacyNameList[] => LISTS.filter((list) => list.sample.split(` `).includes(word));

const SURNAME_FORM = /(?:ski|ska|cki|cka|dzki|dzka|wicz|czyk)$/u;

const wordOf = (word: string): PrivacyNameWord => {
    const lists = holders(word.toLocaleLowerCase(`pl`));
    const kind = (k: PrivacyNameList[`kind`]): boolean => lists.some((list) => list.kind === k);
    return {
        word,
        firstName: kind(`first-name`),
        surname: kind(`surname`),
        surnameForm: SURNAME_FORM.test(word.toLocaleLowerCase(`pl`)),
        ambiguous: kind(`ambiguous`),
        never: kind(`title`) || kind(`never`),
    };
};

const asName = (text: string): string =>
    text.toLocaleLowerCase(`pl`).replaceAll(/(^|[\s-])(\p{L})/gu, (_, before: string, letter: string) => `${before}${letter.toLocaleUpperCase(`pl`)}`);

const NAME_LIKE = /^[\p{L}'-]+(?: [\p{L}'-]+){0,4}$/u;

export const demoNameDictionary = (query?: string): PrivacyDictionary => {
    const lists = LISTS.map(({ sample: _, ...list }) => list);
    const totals = { firstNames: 2_378, surnames: 11_546 };
    const typed = query?.trim().replaceAll(/\s+/gu, ` `) ?? ``;
    if (!NAME_LIKE.test(typed)) {
        return { lists, totals, matches: [] };
    }
    const prefix = typed.toLocaleLowerCase(`pl`);
    const words = [...new Set(LISTS.flatMap((list) => list.sample.split(` `)))].toSorted((a, b) => a.localeCompare(b, `pl`));
    const matches = prefix.includes(` `)
        ? []
        : words
              .filter((word) => word.startsWith(prefix))
              .slice(0, PRIVACY_DICTIONARY_SAMPLE_MAX)
              .map((word) => ({ word, lists: holders(word).map((list) => list.id) }));
    const text = asName(typed);
    const parts = text.split(` `).map(wordOf);
    const named = (part: PrivacyNameWord): boolean => (part.firstName || part.surname) && !part.ambiguous && !part.never;
    return { lists, totals, matches, lookup: { text, found: parts.length <= 3 && parts.every(named), words: parts } };
};
