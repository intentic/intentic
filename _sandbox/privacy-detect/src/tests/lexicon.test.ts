import { detectPersonalData } from "../detect.js";
import { builtInLexicon, createLexicon, type LexiconConfig } from "../lexicon.js";
import { listWords, NAME_LIST_IDS, NAME_LISTS } from "../name-lists.js";
import { fullNameAlone } from "../standalone.js";

// The name lists as the owner sets them: a built-in list switched off is no longer read, and a list of their own is read
// beside the rest, by the same rules (a first name still needs a surname that is no ordinary word, a title still
// announces the word after it).

const names = (text: string, config: LexiconConfig = {}): string[] =>
    detectPersonalData(text, { classes: new Set(["person-name"]), lexicon: createLexicon(config) }).map((span) => span.value);

describe("the name-list registry", () => {
    test("names every list once, each with words", () => {
        expect(NAME_LIST_IDS.size).toBe(NAME_LISTS.length);
        for (const list of NAME_LISTS) {
            expect(listWords(list).size, list.id).toBeGreaterThan(0);
        }
    });

    test("an unchanged configuration reads the built-in lexicon itself", () => {
        expect(createLexicon({})).toBe(builtInLexicon());
        expect(createLexicon({ off: [], own: [{ kind: "first-name", matching: "as-written", words: [] }] })).toBe(builtInLexicon());
    });
});

describe("lists switched off", () => {
    test("a surname only the switched-off register knows no longer completes a name", () => {
        expect(names("Spotkanie: Anna Nowak przyjdzie jutro.")).toEqual(["Anna Nowak"]);
        expect(names("Spotkanie: Anna Nowak przyjdzie jutro.", { off: ["surnames-pl"] })).toEqual([]);
    });

    test("without the titles, a title announces nobody", () => {
        expect(names("Rozmawiałem z panem Zdzisławem Qwertym.")).not.toEqual([]);
        expect(names("Rozmawiałem z panem Qwertym.", { off: ["titles-pl"] })).toEqual([]);
    });
});

describe("the owner's own lists", () => {
    test("a first name of their own pairs with a listed surname", () => {
        expect(names("Umowę podpisała Qwertyna Nowak.")).toEqual([]);
        expect(names("Umowę podpisała Qwertyna Nowak.", { own: [{ kind: "first-name", matching: "as-written", words: ["Qwertyna"] }] })).toEqual([
            "Qwertyna Nowak",
        ]);
    });

    test("a surname of their own completes a listed first name, inflected only when asked", () => {
        const own = (matching: "inflected" | "as-written"): LexiconConfig => ({ own: [{ kind: "surname", matching, words: ["qwertyuk"] }] });
        expect(names("Dzwoniła Anna Qwertyuk.")).toEqual([]);
        expect(names("Dzwoniła Anna Qwertyuk.", own("as-written"))).toEqual(["Anna Qwertyuk"]);
        expect(names("Rozmawiałem z Anną Qwertyukiem.", own("as-written"))).toEqual([]);
        expect(names("Rozmawiałem z Anną Qwertyukiem.", own("inflected"))).toEqual(["Anną Qwertyukiem"]);
    });

    test("a word they mark as never a name, or as an ordinary word, stops completing one", () => {
        expect(names("Dzwoniła Anna Nowak.", { own: [{ kind: "never", matching: "as-written", words: ["Nowak"] }] })).toEqual([]);
        expect(names("Dzwoniła Anna Nowak.", { own: [{ kind: "ambiguous", matching: "as-written", words: ["nowak"] }] })).toEqual([]);
    });

    test("a title of their own announces the word after it, with or without its dot", () => {
        expect(names("Danke, Herr Qwerty, bis morgen.")).toEqual([]);
        expect(names("Danke, Herr Qwerty, bis morgen.", { own: [{ kind: "title", matching: "as-written", words: ["Herr"] }] })).toEqual(["Qwerty"]);
        expect(names("Notiz von Hr. Qwerty.", { own: [{ kind: "title", matching: "as-written", words: ["hr."] }] })).toEqual(["Qwerty"]);
    });

    test("a full name standing alone is held to the owner's never-words too", () => {
        expect(fullNameAlone("Anna Nowak")).toBe(true);
        expect(fullNameAlone("Anna Nowak", createLexicon({ own: [{ kind: "never", matching: "as-written", words: ["nowak"] }] }))).toBe(false);
    });
});
