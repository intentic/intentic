import type { Graph, Note, NoteLink, NoteSummary, Overview, SearchHit } from "../contract.js";
import { overviewOf, type KnowledgeIndex } from "./index-notes.js";
import { factsOf, type ParsedNote } from "./note.js";
import type { GraphView, SearchHit as EngineHit } from "./query.js";

// Turns the engine's answers into the contract's wire shapes. Pure and separate from the backend, since the demo
// fixture calls it too, without re-deriving backlinks and counts by hand. Fields are copied across explicitly so an
// engine field can't reach the wire undeclared.

export const summaryOf = (note: ParsedNote, index: KnowledgeIndex): NoteSummary => ({
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

// A connection resolved for a reader: an unresolved target keeps its raw text as the display name.
const outgoing = (index: KnowledgeIndex, path: string): NoteLink[] =>
    (index.outgoing.get(path) ?? []).map((edge) => ({
        relation: edge.relation,
        path: edge.to,
        title: edge.to === undefined ? edge.target : (index.byPath.get(edge.to)?.title ?? edge.to),
    }));

const incoming = (index: KnowledgeIndex, path: string): NoteLink[] =>
    (index.backlinks.get(path) ?? []).map((edge) => ({
        relation: edge.relation,
        path: edge.from,
        title: index.byPath.get(edge.from)?.title ?? edge.from,
    }));

export const noteOf = (note: ParsedNote, index: KnowledgeIndex): Note => ({
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

// `folder` is workspace-relative; it's the one thing about this report the index itself can't know.
export const overviewFor = (index: KnowledgeIndex, folder: string): Overview => {
    const report = overviewOf(index);
    return {
        folder,
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
