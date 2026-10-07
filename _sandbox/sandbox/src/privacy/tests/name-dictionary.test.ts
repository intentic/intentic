import { PRIVACY_DICTIONARY_SAMPLE_MAX } from "@intentic/sandbox-contract";
import { FIRST_NAMES_PL } from "../detect/data/first-names-pl.js";
import { SURNAMES_PL } from "../detect/data/surnames-pl.js";
import { lookUpName, nameDictionary } from "../name-dictionary.js";

// The dictionary as the owner reads it on the privacy page: the detector's own lists, counted, and for a query what
// the detector makes of it. Read from the lists the detector reads, so a word added there shows here without a copy.

const firstOf = (words: string): string => words.split(/\s+/u).find((word) => word !== "") ?? "";

describe("the lists", () => {
    test("every list is named once, holds words, and says how it matches and where its words come from", () => {
        const { lists } = nameDictionary();
        expect(new Set(lists.map((list) => list.id)).size).toBe(lists.length);
        for (const list of lists) {
            expect(list.count).toBeGreaterThan(0);
            expect(list.source).not.toBe("");
            expect(list.languages.length).toBeGreaterThan(0);
        }
        // The registers come with their page and license; a hand-written list has neither.
        expect(lists.find((list) => list.id === "surnames-pl")).toMatchObject({ kind: "surname", matching: "inflected", license: "CC0 1.0" });
        expect(lists.find((list) => list.id === "titles-pl")?.url).toBeUndefined();
    });

    test("the totals count each word once, however many lists hold it", () => {
        const { lists, totals } = nameDictionary();
        const counts = (kind: string): number[] => lists.filter((list) => list.kind === kind).map((list) => list.count);
        for (const [kind, total] of [
            ["first-name", totals.firstNames],
            ["surname", totals.surnames],
        ] as const) {
            expect(total).toBeGreaterThanOrEqual(Math.max(...counts(kind)));
            expect(total).toBeLessThanOrEqual(counts(kind).reduce((sum, count) => sum + count, 0));
        }
    });

    test("the words are the detector's own: the first of each register is found on its list", () => {
        const first = firstOf(FIRST_NAMES_PL);
        const surname = firstOf(SURNAMES_PL);
        expect(nameDictionary(first).matches.find((match) => match.word === first)?.lists).toContain("first-names-pl");
        expect(nameDictionary(surname).matches.find((match) => match.word === surname)?.lists).toContain("surnames-pl");
    });
});

describe("a query", () => {
    test("a start of a word browses the listed words beginning with it, alphabetically, a page at most", () => {
        const { matches } = nameDictionary("Kow");
        expect(matches.length).toBeGreaterThan(0);
        expect(matches.every((match) => match.word.startsWith("kow"))).toBe(true);
        expect(matches.map((match) => match.word)).toEqual(matches.map((match) => match.word).toSorted((a, b) => a.localeCompare(b, "pl")));
        expect(nameDictionary("a").matches).toHaveLength(PRIVACY_DICTIONARY_SAMPLE_MAX);
    });

    test("a listed first name alone is not masked; a first name with a listed surname is", () => {
        const single = lookUpName("anna");
        expect(single).toMatchObject({ found: false, words: [{ firstName: true, never: false }] });
        const full = lookUpName("jan   kowalski");
        expect(full.found).toBe(true);
        expect(full.words.map((word) => [word.firstName, word.surname])).toEqual([
            [true, false],
            [false, true],
        ]);
        // Written as a name is, whatever case it was typed in, one space between its words.
        expect(full.text.split(" ").map((word) => word.charAt(0) === word.charAt(0).toUpperCase())).toEqual([true, true]);
    });

    test("a name that is also a word needs other evidence, and a title is never part of a name", () => {
        expect(lookUpName("róża")).toMatchObject({ found: false, words: [{ firstName: true, ambiguous: true }] });
        expect(lookUpName("pan")).toMatchObject({ found: false, words: [{ never: true }] });
    });

    test("a full name browses nothing, and what no list could hold is no lookup at all", () => {
        expect(nameDictionary("jan kowalski").matches).toEqual([]);
        expect(nameDictionary("1234").lookup).toBeUndefined();
        expect(nameDictionary("   ").lookup).toBeUndefined();
        expect(nameDictionary("a b c d e f").lookup).toBeUndefined();
    });
});
