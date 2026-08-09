import { type NoteFile, parseNote, type VaultNote } from "./note.js";
import { type Drift, relationDrift, type Vocabulary, readVocabulary, typeDrift, VOCABULARY_TYPE } from "./vocabulary.js";

/* THE VAULT, RESOLVED — the one place a pile of files becomes a graph.
 *
 * Everything here is derived and nothing is stored. There is no index file to rebuild, go stale, or disagree
 * with the notes: a vault of a few thousand small markdown files parses in milliseconds, so the honest answer
 * is to read it. The backend builds one per request and the CLI builds one per run (read-vault.ts); both
 * end at exactly the same object, which is what keeps the panel and the agent from telling different stories. */

export interface VaultEdge {
    readonly from: string;
    // The resolved note, or undefined when the link points at something that isn't there yet. BOTH are kept:
    // an unresolved link is not an error, it is a note somebody has not written — the vault's own to-do list.
    readonly to: string | undefined;
    readonly target: string;
    readonly relation: string | undefined;
}

export interface VaultIndex {
    readonly notes: readonly VaultNote[];
    readonly byPath: ReadonlyMap<string, VaultNote>;
    readonly edges: readonly VaultEdge[];
    // Incoming edges per note path — what links HERE, which is the half a plain file tree cannot show you.
    readonly backlinks: ReadonlyMap<string, readonly VaultEdge[]>;
    readonly outgoing: ReadonlyMap<string, readonly VaultEdge[]>;
    readonly vocabulary: Vocabulary;
    // A link target that matches more than one note. Reported so the vault can be disambiguated; resolution
    // picks the first in path order so behaviour stays deterministic either way.
    readonly ambiguous: ReadonlyMap<string, readonly string[]>;
    // Resolve a link target the way a vault does: by path, then filename, then title, then alias.
    resolve(target: string): VaultNote | undefined;
}

const normalise = (value: string): string => value.trim().toLowerCase();

// A link may be written with or without the extension, and with or without folders — `[[Ada Lovelace]]`,
// `[[ada-lovelace]]`, `[[people/ada-lovelace]]`, `[[people/ada-lovelace.md]]` all mean the same note.
const pathKeys = (path: string): string[] => {
    const withoutExtension = path.replace(/\.md$/i, "");
    return [normalise(path), normalise(withoutExtension)];
};

/* The lookup table, built in FOUR passes so that a stronger kind of match always wins over a weaker one however
 * the vault happens to be ordered: a note whose title is "Ada" beats a different note that merely lists "Ada"
 * as an alias, whichever of them the directory walk reached first. Within one pass the first note in path order
 * wins and the collision is recorded.
 *
 * Path before title before alias, because that is the order of how deliberate the name is: a filename was
 * chosen for this note, an alias is a convenience that may be shared. */
const buildLookup = (notes: readonly VaultNote[]): { lookup: Map<string, VaultNote>; ambiguous: Map<string, string[]> } => {
    const lookup = new Map<string, VaultNote>();
    const ambiguous = new Map<string, string[]>();
    const passes: ((note: VaultNote) => readonly string[])[] = [
        (note) => pathKeys(note.path),
        (note) => [normalise(note.slug)],
        (note) => [normalise(note.title)],
        (note) => note.aliases.map(normalise),
    ];
    for (const keysOf of passes) {
        const claimed = new Map<string, VaultNote>();
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

export const buildIndex = (files: readonly NoteFile[]): VaultIndex => {
    // Path order, so every tie above is broken the same way on every machine and every run.
    const notes = files.map(parseNote).toSorted((a, b) => a.path.localeCompare(b.path));
    const { lookup, ambiguous } = buildLookup(notes);
    const resolve = (target: string): VaultNote | undefined => {
        const key = normalise(target.split("#")[0] ?? target);
        return lookup.get(key) ?? lookup.get(key.replace(/\.md$/i, ""));
    };

    const edges: VaultEdge[] = notes.flatMap((note) =>
        note.links.map((link) => ({ from: note.path, to: resolve(link.target)?.path, target: link.target, relation: link.relation })),
    );
    const backlinks = new Map<string, VaultEdge[]>();
    const outgoing = new Map<string, VaultEdge[]>();
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

// ---- what the vault amounts to, and what is wrong with it -------------------------------------------------

export interface VaultCount {
    readonly name: string;
    readonly count: number;
}

export interface BrokenLink {
    readonly from: string;
    readonly target: string;
    readonly relation: string | undefined;
}

export interface VaultOverview {
    readonly noteCount: number;
    readonly linkCount: number;
    readonly types: readonly VaultCount[];
    readonly tags: readonly VaultCount[];
    readonly vocabulary: Vocabulary;
    // Links pointing at a note nobody has written. The vault's to-do list, not its error list.
    readonly broken: readonly BrokenLink[];
    // Notes nothing links to and which link to nothing — knowledge that fell out of the graph and will never
    // be found again by following anything.
    readonly orphans: readonly string[];
    // Notes with no `type:` — usable, but invisible to every "show me every decision about X" question.
    readonly untyped: readonly string[];
    readonly typeDrift: readonly Drift[];
    readonly relationDrift: readonly Drift[];
    // Header keys the parser could not read, per note — the only way a malformed header is ever announced.
    readonly unreadable: readonly { readonly path: string; readonly keys: readonly string[] }[];
    readonly ambiguous: readonly { readonly name: string; readonly notes: readonly string[] }[];
}

const counted = (values: readonly string[]): VaultCount[] => {
    const counts = new Map<string, number>();
    for (const value of values) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count })).toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name));
};

export const overviewOf = (index: VaultIndex): VaultOverview => ({
    noteCount: index.notes.length,
    linkCount: index.edges.length,
    types: counted(index.notes.flatMap((note) => (note.type === undefined ? [] : [note.type]))),
    tags: counted(index.notes.flatMap((note) => note.tags)),
    vocabulary: index.vocabulary,
    broken: index.edges.flatMap((edge) => (edge.to === undefined ? [{ from: edge.from, target: edge.target, relation: edge.relation }] : [])),
    /* The vocabulary note is never an orphan however few links it holds — it is the vault's structure, not a
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
