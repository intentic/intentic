import { type NoteFile, parseNote, type ParsedNote } from "./note.js";
import { type Drift, relationDrift, type Vocabulary, readVocabulary, typeDrift, VOCABULARY_TYPE } from "./vocabulary.js";

/* THE KNOWLEDGE BASE, RESOLVED, the one place a pile of files becomes a graph.
 *
 * Everything here is derived and nothing is stored. There is no index file to rebuild, go stale, or disagree
 * with the notes: a knowledge base of a few thousand small markdown files parses in milliseconds, so the honest answer
 * is to read it. The backend builds one per request and the CLI builds one per run (read-notes.ts); both
 * end at exactly the same object, which is what keeps the panel and the agent from telling different stories. */

export interface NoteEdge {
    readonly from: string;
    // The resolved note, or undefined when the link points at something that isn't there yet. BOTH are kept:
    // an unresolved link is not an error, it is a note somebody has not written, the knowledge base's own to-do list.
    readonly to: string | undefined;
    readonly target: string;
    readonly relation: string | undefined;
}

export interface KnowledgeIndex {
    readonly notes: readonly ParsedNote[];
    readonly byPath: ReadonlyMap<string, ParsedNote>;
    readonly edges: readonly NoteEdge[];
    // Incoming edges per note path, what links HERE, which is the half a plain file tree cannot show you.
    readonly backlinks: ReadonlyMap<string, readonly NoteEdge[]>;
    readonly outgoing: ReadonlyMap<string, readonly NoteEdge[]>;
    readonly vocabulary: Vocabulary;
    // A link target that matches more than one note. Reported so the knowledge base can be disambiguated; resolution
    // picks the first in path order so behaviour stays deterministic either way.
    readonly ambiguous: ReadonlyMap<string, readonly string[]>;
    // Resolve a link target the way a knowledge base does: by path, then filename, then title, then alias.
    resolve(target: string): ParsedNote | undefined;
}

const normalise = (value: string): string => value.trim().toLowerCase();

// A link may be written with or without the extension, and with or without folders, `[[Ada Lovelace]]`,
// `[[ada-lovelace]]`, `[[people/ada-lovelace]]`, `[[people/ada-lovelace.md]]` all mean the same note.
const pathKeys = (path: string): string[] => {
    const withoutExtension = path.replace(/\.md$/i, "");
    return [normalise(path), normalise(withoutExtension)];
};

/* The lookup table, built in FOUR passes so that a stronger kind of match always wins over a weaker one however
 * the knowledge base happens to be ordered: a note whose title is "Ada" beats a different note that merely lists "Ada"
 * as an alias, whichever of them the directory walk reached first. Within one pass the first note in path order
 * wins and the collision is recorded.
 *
 * Path before title before alias, because that is the order of how deliberate the name is: a filename was
 * chosen for this note, an alias is a convenience that may be shared. */
const buildLookup = (notes: readonly ParsedNote[]): { lookup: Map<string, ParsedNote>; ambiguous: Map<string, string[]> } => {
    const lookup = new Map<string, ParsedNote>();
    const ambiguous = new Map<string, string[]>();
    const passes: ((note: ParsedNote) => readonly string[])[] = [
        (note) => pathKeys(note.path),
        (note) => [normalise(note.slug)],
        (note) => [normalise(note.title)],
        (note) => note.aliases.map(normalise),
    ];
    for (const keysOf of passes) {
        const claimed = new Map<string, ParsedNote>();
        for (const note of notes) {
            for (const key of keysOf(note)) {
                if (key === "") {
                    continue;
                }
                const held = claimed.get(key);
                if (held === undefined) {
                    claimed.set(key, note);
                } else if (held !== note) {
                    ambiguous.set(key, [...new Set([...(ambiguous.get(key) ?? [held.path]), note.path])]);
                }
            }
        }
        for (const [key, note] of claimed) {
            if (!lookup.has(key)) {
                lookup.set(key, note);
            }
        }
    }
    return { lookup, ambiguous };
};

export const buildIndex = (files: readonly NoteFile[]): KnowledgeIndex => {
    // Path order, so every tie above is broken the same way on every machine and every run.
    const notes = files.map(parseNote).toSorted((a, b) => a.path.localeCompare(b.path));
    const { lookup, ambiguous } = buildLookup(notes);
    const resolve = (target: string): ParsedNote | undefined => {
        const key = normalise(target.split("#")[0] ?? target);
        return lookup.get(key) ?? lookup.get(key.replace(/\.md$/i, ""));
    };

    const edges: NoteEdge[] = notes.flatMap((note) =>
        note.links.map((link) => ({ from: note.path, to: resolve(link.target)?.path, target: link.target, relation: link.relation })),
    );
    const backlinks = new Map<string, NoteEdge[]>();
    const outgoing = new Map<string, NoteEdge[]>();
    for (const edge of edges) {
        outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
        if (edge.to !== undefined && edge.to !== edge.from) {
            backlinks.set(edge.to, [...(backlinks.get(edge.to) ?? []), edge]);
        }
    }
    return {
        notes,
        byPath: new Map(notes.map((note) => [note.path, note])),
        edges,
        backlinks,
        outgoing,
        vocabulary: readVocabulary(notes),
        ambiguous,
        resolve,
    };
};

// ---- what the knowledge base amounts to, and what is wrong with it -------------------------------------------------

export interface NameCount {
    readonly name: string;
    readonly count: number;
}

export interface BrokenLink {
    readonly from: string;
    readonly target: string;
    readonly relation: string | undefined;
}

export interface KnowledgeOverview {
    readonly noteCount: number;
    readonly linkCount: number;
    readonly types: readonly NameCount[];
    readonly tags: readonly NameCount[];
    readonly vocabulary: Vocabulary;
    // Links pointing at a note nobody has written. The knowledge base's to-do list, not its error list.
    readonly broken: readonly BrokenLink[];
    // Notes nothing links to and which link to nothing, knowledge that fell out of the graph and will never
    // be found again by following anything.
    readonly orphans: readonly string[];
    // Notes with no `type:`, usable, but invisible to every "show me every decision about X" question.
    readonly untyped: readonly string[];
    readonly typeDrift: readonly Drift[];
    readonly relationDrift: readonly Drift[];
    // Header keys the parser could not read, per note, the only way a malformed header is ever announced.
    readonly unreadable: readonly { readonly path: string; readonly keys: readonly string[] }[];
    readonly ambiguous: readonly { readonly name: string; readonly notes: readonly string[] }[];
}

const counted = (values: readonly string[]): NameCount[] => {
    const counts = new Map<string, number>();
    for (const value of values) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count })).toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name));
};

export const overviewOf = (index: KnowledgeIndex): KnowledgeOverview => ({
    noteCount: index.notes.length,
    linkCount: index.edges.length,
    types: counted(index.notes.flatMap((note) => (note.type === undefined ? [] : [note.type]))),
    tags: counted(index.notes.flatMap((note) => note.tags)),
    vocabulary: index.vocabulary,
    broken: index.edges.flatMap((edge) => (edge.to === undefined ? [{ from: edge.from, target: edge.target, relation: edge.relation }] : [])),
    /* The vocabulary note is never an orphan however few links it holds, it is the knowledge base's structure, not a
     * fact that fell out of it, and reporting it would put a permanent entry in a list whose whole value is
     * being empty most of the time. */
    orphans: index.notes
        .filter(
            (note) =>
                note.type !== VOCABULARY_TYPE &&
                (index.backlinks.get(note.path) ?? []).length === 0 &&
                (index.outgoing.get(note.path) ?? []).length === 0,
        )
        .map((note) => note.path),
    untyped: index.notes.filter((note) => note.type === undefined).map((note) => note.path),
    typeDrift: typeDrift(index.notes, index.vocabulary),
    relationDrift: relationDrift(index.notes, index.vocabulary),
    unreadable: index.notes.flatMap((note) => (note.unreadable.length === 0 ? [] : [{ path: note.path, keys: note.unreadable }])),
    ambiguous: [...index.ambiguous].map(([name, notes]) => ({ name, notes })).toSorted((a, b) => a.name.localeCompare(b.name)),
});
