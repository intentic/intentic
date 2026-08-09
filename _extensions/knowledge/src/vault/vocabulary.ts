import type { VaultNote } from "./note.js";

/* THE VAULT'S DECLARED VOCABULARY — which kinds of thing and which relationships this vault has agreed to use.
 *
 * It is a NOTE, not a config file and not a schema the tools enforce. That is the whole design decision, and
 * it is the difference between a knowledge base an agent fills and one it stalls against:
 *
 *   - An agent meets a new kind of thing MID-TASK. If declaring it first were required, the capture would fail
 *     at the moment the fact was in hand, and the fact is what we were trying to keep. So an undeclared type
 *     works immediately.
 *   - Left at that, the vault silently accumulates `person`, `people`, `Person` and `human` as four kinds. So
 *     everything undeclared is REPORTED — in the panel's overview and in `kb check` — as drift to adopt or
 *     rename. The vocabulary is a habit the tools help keep, not a gate they enforce.
 *
 * A note, rather than a JSON file, because the agent reads it: the prose under the header is where "a decision
 * is a choice we made and won't revisit without cause" gets said, and no field on a schema would carry that. */

// The note that declares it. Any note may claim the role by its type; the underscore keeps the conventional one
// at the top of a sorted vault listing, out of the way of the notes that are about something.
export const VOCABULARY_TYPE = "vocabulary";
export const VOCABULARY_PATH = "_vocabulary.md";

export interface Vocabulary {
    readonly types: readonly string[];
    readonly relations: readonly string[];
    // The note it was read from, so the panel can offer to open it. Undefined ⇒ this vault has declared none,
    // which is a legitimate state: everything is then simply undeclared, and nothing is reported as drift.
    readonly path: string | undefined;
}

// A vault that has declared none — a legitimate state, not a missing one: everything is then simply
// undeclared, and nothing is reported as drift.
const EMPTY_VOCABULARY: Vocabulary = { types: [], relations: [], path: undefined };

export const readVocabulary = (notes: readonly VaultNote[]): Vocabulary => {
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

// A word this vault has not adopted, and how many notes use it — the drift report, in the shape both the
// overview panel and `kb check` render. Sorted by weight: the one used twelve times is the one worth a decision.
export interface Drift {
    readonly word: string;
    readonly uses: number;
    // Which notes use it, capped by the caller — enough to go look, not a second copy of the vault.
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

/* Types in use that the vocabulary does not list. A vault with NO vocabulary reports nothing — there is nothing
 * to have drifted from, and a fresh vault flagging every note it holds would be noise on the day it is least
 * useful. The vocabulary note's own type is never drift, however it is spelled. */
export const typeDrift = (notes: readonly VaultNote[], vocabulary: Vocabulary): Drift[] => {
    if (vocabulary.path === undefined) {
        return [];
    }
    const declared = new Set([...vocabulary.types, VOCABULARY_TYPE]);
    return tally(notes.flatMap((note) => (note.type === undefined || declared.has(note.type) ? [] : [[note.type, note.path] as const])));
};

// Relationship names in use that the vocabulary does not list — the same rule, over the header fields that
// carry links.
export const relationDrift = (notes: readonly VaultNote[], vocabulary: Vocabulary): Drift[] => {
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
