import type { ParsedNote } from "./note.js";

// The vocabulary a knowledge base has agreed to (types and relationships), stored as a note, not an enforced schema: an
// undeclared kind must still capture immediately. Undeclared use is reported as drift (panel overview, `kb check`), not
// blocked.

// Any note may claim the role by its type; the underscore keeps the conventional one atop a sorted listing.
export const VOCABULARY_TYPE = "vocabulary";
export const VOCABULARY_PATH = "_vocabulary.md";

export interface Vocabulary {
    readonly types: readonly string[];
    readonly relations: readonly string[];
    // Note it was read from, so the panel can open it; undefined means none declared, a legitimate state.
    readonly path: string | undefined;
}

// No vocabulary declared is legitimate: everything is then simply undeclared, nothing reported as drift.
const EMPTY_VOCABULARY: Vocabulary = { types: [], relations: [], path: undefined };

export const readVocabulary = (notes: readonly ParsedNote[]): Vocabulary => {
    const note = notes.find((candidate) => candidate.type === VOCABULARY_TYPE);
    if (note === undefined) {
        return EMPTY_VOCABULARY;
    }
    return {
        types: note.fields.get("types") ?? [],
        relations: note.fields.get("relations") ?? [],
        path: note.path,
    };
};

// A word not adopted by the vocabulary, and how many notes use it; sorted by weight for the overview and `kb check`.
export interface Drift {
    readonly word: string;
    readonly uses: number;
    // Notes using it, capped by the caller; enough to go look, not a duplicate of the knowledge base.
    readonly notes: readonly string[];
}

const tally = (entries: readonly (readonly [string, string])[]): Drift[] => {
    const byWord = new Map<string, string[]>();
    for (const [word, path] of entries) {
        byWord.set(word, [...(byWord.get(word) ?? []), path]);
    }
    return [...byWord]
        .map(([word, paths]) => ({ word, uses: paths.length, notes: paths.slice(0, 10) }))
        .toSorted((a, b) => b.uses - a.uses || a.word.localeCompare(b.word));
};

// Types in use the vocabulary doesn't list. A knowledge base with no vocabulary reports nothing, not noise on day one;
// the vocabulary note's own type is never drift.
export const typeDrift = (notes: readonly ParsedNote[], vocabulary: Vocabulary): Drift[] => {
    if (vocabulary.path === undefined) {
        return [];
    }
    const declared = new Set([...vocabulary.types, VOCABULARY_TYPE]);
    return tally(notes.flatMap((note) => (note.type === undefined || declared.has(note.type) ? [] : [[note.type, note.path] as const])));
};

// Relationship names in use the vocabulary doesn't list; same rule, over header fields carrying links.
export const relationDrift = (notes: readonly ParsedNote[], vocabulary: Vocabulary): Drift[] => {
    if (vocabulary.path === undefined) {
        return [];
    }
    const declared = new Set(vocabulary.relations);
    return tally(
        notes.flatMap((note) =>
            [...new Set(note.links.flatMap((link) => (link.relation === undefined || declared.has(link.relation) ? [] : [link.relation])))].map(
                (relation) => [relation, note.path] as const,
            ),
        ),
    );
};
