import type { Graph, Note, NoteLink, NoteSummary, Overview, SearchHit } from "../contract.js";
import { overviewOf, type VaultIndex } from "./index-vault.js";
import { factsOf, type VaultNote } from "./note.js";
import type { GraphView, SearchHit as EngineHit } from "./query.js";

/* THE INDEX, AS THE WIRE DECLARES IT — the one place the engine's answers are turned into the contract's
 * shapes.
 *
 * Pure, and separate from the backend that usually calls it, because it has a second caller: the demo fixture,
 * which serves this extension's namespace in a browser with no sandbox behind it. Left inside server.ts, the
 * fixture would have had to re-derive backlinks, counts and the neighbourhood by hand — a second implementation
 * of the interesting half of this extension, shown to visitors as if it were the product.
 *
 * Every field is copied ACROSS rather than spread. The engine answers in readonly arrays and the contract is
 * declared in mutable ones, so a copy is needed either way — and being explicit about it means a field the
 * engine grows cannot arrive on the wire undeclared. */

export const summaryOf = (note: VaultNote, index: VaultIndex): NoteSummary => ({
    path: note.path,
    title: note.title,
    type: note.type,
    tags: [...note.tags],
    aliases: [...note.aliases],
    linkCount: (index.outgoing.get(note.path) ?? []).length,
    backlinkCount: (index.backlinks.get(note.path) ?? []).length,
    sizeBytes: note.sizeBytes,
    modifiedAt: note.modifiedAt,
});

// A connection, resolved for a reader: the panel renders a link, so it needs a destination and a name. An
// unresolved target keeps its raw text as the name — "Charles Babbage (not written yet)" is a real answer.
const outgoing = (index: VaultIndex, path: string): NoteLink[] =>
    (index.outgoing.get(path) ?? []).map((edge) => ({
        relation: edge.relation,
        path: edge.to,
        title: edge.to === undefined ? edge.target : (index.byPath.get(edge.to)?.title ?? edge.to),
    }));

const incoming = (index: VaultIndex, path: string): NoteLink[] =>
    (index.backlinks.get(path) ?? []).map((edge) => ({
        relation: edge.relation,
        path: edge.from,
        title: index.byPath.get(edge.from)?.title ?? edge.from,
    }));

export const noteOf = (note: VaultNote, index: VaultIndex): Note => ({
    summary: summaryOf(note, index),
    content: note.content,
    body: note.body,
    facts: factsOf(note).map(([key, values]) => ({ key, values: [...values] })),
    linksTo: outgoing(index, note.path),
    linkedFrom: incoming(index, note.path),
});

export const hitsOf = (hits: readonly EngineHit[]): SearchHit[] =>
    hits.map((hit) => ({
        path: hit.path,
        title: hit.title,
        type: hit.type,
        tags: [...hit.tags],
        modifiedAt: hit.modifiedAt,
        matched: hit.matched,
        snippet: hit.snippet,
    }));

export const graphOf = (view: GraphView): Graph => ({
    focus: view.focus,
    nodes: view.nodes.map((node) => ({ path: node.path, title: node.title, type: node.type, depth: node.depth })),
    // Only edges between two drawn notes reach the picture; an unresolved one has nowhere to land.
    edges: view.edges.flatMap((edge) => (edge.to === undefined ? [] : [{ from: edge.from, to: edge.to, relation: edge.relation }])),
    omitted: view.omitted,
});

// `vault` is workspace-relative — where the notes actually are, which is the one thing about this report the
// index cannot know.
export const overviewFor = (index: VaultIndex, vault: string): Overview => {
    const report = overviewOf(index);
    return {
        vault,
        noteCount: report.noteCount,
        linkCount: report.linkCount,
        types: report.types.map((entry) => ({ name: entry.name, count: entry.count })),
        tags: report.tags.map((entry) => ({ name: entry.name, count: entry.count })),
        vocabulary: { types: [...report.vocabulary.types], relations: [...report.vocabulary.relations], path: report.vocabulary.path },
        broken: report.broken.map((link) => ({ from: link.from, target: link.target, relation: link.relation })),
        orphans: [...report.orphans],
        untyped: [...report.untyped],
        typeDrift: report.typeDrift.map((drift) => ({ word: drift.word, uses: drift.uses, notes: [...drift.notes] })),
        relationDrift: report.relationDrift.map((drift) => ({ word: drift.word, uses: drift.uses, notes: [...drift.notes] })),
        unreadable: report.unreadable.map((entry) => ({ path: entry.path, keys: [...entry.keys] })),
        ambiguous: report.ambiguous.map((entry) => ({ name: entry.name, notes: [...entry.notes] })),
    };
};
