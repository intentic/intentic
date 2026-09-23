import "@intentic/testing/dom";
import { useVocabulary, vocabularyFor } from "./vocabulary";
import { useAudience } from "../app/useAudience";

// Both columns are read through the same table, so the checks below are about the table's shape rather than any one
// word: a key present in one column and not the other would be a maker screen with a developer word on it.

// The app's catalog is registered by the package preload, so the words below are the real ones rather than their keys.
beforeEach(() => {
    localStorage.clear();
});

describe(`the vocabulary table`, () => {
    it(`spells every key in both columns, and never with the empty string`, () => {
        const developer = vocabularyFor(`developer`);
        const maker = vocabularyFor(`maker`);

        expect(Object.keys(maker).toSorted()).toEqual(Object.keys(developer).toSorted());
        for (const [key, value] of Object.entries({ ...developer, ...maker })) {
            expect(value.trim(), key).not.toBe(``);
        }
    });

    it(`keeps git's own words for a developer and plain ones for a maker`, () => {
        expect(vocabularyFor(`developer`).land).toBe(`Land now`);
        expect(vocabularyFor(`maker`).land).toBe(`Accept`);
        expect(vocabularyFor(`maker`).publish).toBe(vocabularyFor(`maker`).push);
    });

    it(`follows the audience preference as it changes`, () => {
        const words = useVocabulary();

        expect(words.value.home).toBe(`Workspace`);
        useAudience().setAudience(`maker`);
        expect(words.value.home).toBe(`Projects`);
    });
});
