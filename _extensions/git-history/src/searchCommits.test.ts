import type { GitCommit } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { matchesSearch, searchWords } from "./searchCommits.js";

const commit = (over: Partial<GitCommit> = {}): GitCommit => ({
    sha: `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2`,
    short: `a1b2c3d`,
    parents: [],
    subject: `feat(graph): lane colours`,
    body: ``,
    author: `Renée Dupont`,
    email: `renee@example.com`,
    at: 0,
    refs: [],
    head: false,
    ...over,
});

const find = (term: string, target = commit()): boolean => matchesSearch(target, searchWords(term));

describe(`matchesSearch`, () => {
    it(`matches everything when nothing has been typed`, () => {
        expect(find(``)).toBe(true);
        expect(find(`   `)).toBe(true);
    });

    /* EVERY WORD MUST MATCH, BUT ANY FIELD MAY BE THE ONE THAT MATCHES IT. This is the rule that makes searching
     * a log feel right — people remember a fragment of the message and a fragment of who wrote it, not two
     * fragments of the same field. */
    it(`requires every word, across any mix of fields`, () => {
        expect(find(`lane colours`)).toBe(true); // both in the subject
        expect(find(`lane renee`)).toBe(true); // one subject, one author
        expect(find(`lane nonsense`)).toBe(false); // one word with nowhere to match
    });

    it(`ignores accents on both sides, so a plain keyboard finds an accented name`, () => {
        expect(find(`renee`)).toBe(true);
        expect(find(`Renée`)).toBe(true);
    });

    // Punctuation becomes a word break rather than vanishing, so `feat(graph)` is reachable as two words — and
    // typing the punctuation back in still works.
    it(`treats punctuation as a separator in both the term and the text`, () => {
        expect(find(`feat graph`)).toBe(true);
        expect(find(`feat(graph)`)).toBe(true);
    });

    it(`matches a sha by its prefix, which is how one gets pasted in`, () => {
        expect(find(`a1b2c3d`)).toBe(true);
        expect(find(`ffffff`)).toBe(false);
    });

    it(`searches the body and the ref decorations too`, () => {
        expect(find(`hotfix`, commit({ body: `cherry-picked from hotfix` }))).toBe(true);
        expect(find(`release`, commit({ refs: [`origin/release-2`] }))).toBe(true);
    });

    it(`is case-insensitive`, () => {
        expect(find(`LANE COLOURS`)).toBe(true);
    });
});
