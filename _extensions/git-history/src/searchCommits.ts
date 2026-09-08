import type { GitCommit } from "@intentic/sandbox-contract";

// Every typed word must match somewhere in a commit (subject, body, author, email, refs, or sha), each field a
// candidate on its own, so more words always narrow. Accents and punctuation are folded before comparing (`feat(graph)`
// becomes `feat graph`); the sha is compared raw as a hex prefix.

// Folds text so two people typing the same word agree: decomposed accents dropped, punctuation flattened to spaces (not
// removed, so `feat(graph)` yields two words).
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
        // Raw: a sha is hex with no accents, and a prefix is exactly how people paste one.
        commit.sha.toLowerCase(),
        ...commit.refs.map((ref) => fold(ref)),
    ];
    return words.every((word) => fields.some((field) => field.includes(word)));
};
