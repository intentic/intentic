// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Both columns are read through the same table, so the checks below are about the table's shape rather than any one
// word: a key present in one column and not the other would be a maker screen with a developer word on it.

const load = async () => {
    const [{ vocabularyFor, useVocabulary }, { useAudience }] = await Promise.all([import("./vocabulary"), import("../app/useAudience")]);
    return { vocabularyFor, useVocabulary, useAudience };
};

beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
});

describe(`the vocabulary table`, () => {
    it(`spells every key in both columns, and never with the empty string`, async () => {
        const { vocabularyFor } = await load();
        const developer = vocabularyFor(`developer`);
        const maker = vocabularyFor(`maker`);

        expect(Object.keys(maker).toSorted()).toEqual(Object.keys(developer).toSorted());
        for (const [key, value] of Object.entries({ ...developer, ...maker })) {
            expect(value.trim(), key).not.toBe(``);
        }
    });

    it(`keeps git's own words for a developer and plain ones for a maker`, async () => {
        const { vocabularyFor } = await load();

        expect(vocabularyFor(`developer`).land).toBe(`Land now`);
        expect(vocabularyFor(`maker`).land).toBe(`Accept`);
        expect(vocabularyFor(`maker`).publish).toBe(vocabularyFor(`maker`).push);
    });

    it(`follows the audience preference as it changes`, async () => {
        const { useVocabulary, useAudience } = await load();
        const words = useVocabulary();

        expect(words.value.home).toBe(`Workspace`);
        useAudience().setAudience(`maker`);
        expect(words.value.home).toBe(`Project`);
    });
});
