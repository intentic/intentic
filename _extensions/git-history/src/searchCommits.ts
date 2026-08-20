import type { GitCommit } from "@intentic/sandbox-contract";

/* NARROWING THE GRAPH TO WHAT YOU ARE LOOKING FOR.
 *
 * The rule, which is git-go's and worth keeping: EVERY word the reader typed must match SOMEWHERE, but any field
 * may be the somewhere. So "auth fix" finds a commit whose subject says "fix" and whose author is Auth-somebody,
 * and typing more words always narrows. The alternative, one field, all words, fails the way people actually
 * search a log, which is by remembering a fragment of one thing and a fragment of another.
 *
 * Accents and punctuation are stripped from both sides before comparing, so "resume" finds "résumé" and
 * "feat(graph):" is reachable by typing "feat graph". The sha is compared raw: it has no accents and a partial
 * hex prefix is exactly how people paste one.
 *
 * Pure and unit-tested, and separate from the component for the same reason the lane layout is. */

// Fold to something two humans typing the same word would agree on: decomposed accents dropped, punctuation
// flattened to spaces (rather than removed, so `feat(graph)` yields two words instead of one run-on).
const fold = (text: string): string =>
    text
        .normalize(`NFD`)
        .replaceAll(/[̀-ͯ]/g, ``)
        .replaceAll(/[^a-zA-Z0-9\s]/g, ` `)
        .trim()
        .toLowerCase();

export const searchWords = (term: string): readonly string[] =>
    fold(term)
        .split(/\s+/)
        .filter((word) => word !== ``);

export const matchesSearch = (commit: GitCommit, words: readonly string[]): boolean => {
    if (words.length === 0) {
        return true;
    }
    const fields = [
        fold(commit.subject),
        fold(commit.body),
        fold(commit.author),
        fold(commit.email),
        // Raw: a sha is hex, and a prefix of one is what gets pasted in.
        commit.sha.toLowerCase(),
        ...commit.refs.map((ref) => fold(ref)),
    ];
    return words.every((word) => fields.some((field) => field.includes(word)));
};
