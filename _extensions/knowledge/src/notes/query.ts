import type { NoteEdge, KnowledgeIndex } from "./index-notes.js";
import { factsOf, type ParsedNote } from "./note.js";
import { wikiLinksIn } from "./wiki-links.js";

// Search, filter, and the neighbourhood around one note. Ranking is explainable, not a second retrieval engine: the
// note actually named that, then one that goes by that, then notes that mention it. Fuzzy prose search is `iq`'s job,
// not this one's.

export interface SearchFilters {
    readonly query?: string | undefined;
    readonly type?: string | undefined;
    readonly tag?: string | undefined;
    // Notes that link to this one, by any relation ("everything about the Intentic project").
    readonly linkedTo?: string | undefined;
    readonly limit?: number | undefined;
}

export interface SearchHit {
    readonly path: string;
    readonly title: string;
    readonly type: string | undefined;
    readonly tags: readonly string[];
    readonly modifiedAt: number;
    // Why this note matched, in one word: title, alias, tag, type, field, or body.
    readonly matched: string;
    // The matching line or fact; absent for a name match, where the title itself is the evidence.
    readonly snippet: string | undefined;
    readonly score: number;
}

const DEFAULT_LIMIT = 50;

// Tiers, not a formula: the gap between them keeps body matches from ever outranking an actual name match.
const TITLE_EXACT = 1000;
const ALIAS_EXACT = 900;
const TITLE_PREFIX = 700;
const TITLE_CONTAINS = 500;
const TAG_OR_TYPE = 300;
// Header fields are searchable too: what you'd look a note up by may never appear in the prose.
const FIELD = 200;
const BODY = 100;

// Evidence, not source: shown in a narrow column with no renderer, so markdown markup like `**bold**` or `[[links]]`
// would read as damage. Words are kept exactly; only that punctuation is stripped.
const withoutWikiMarkers = (line: string): string => {
    const plain: string[] = [];
    let cursor = 0;
    for (const link of wikiLinksIn(line)) {
        plain.push(line.slice(cursor, link.start), (link.label ?? link.target).trim());
        cursor = link.end;
    }
    plain.push(line.slice(cursor));
    return plain.join("");
};

const plainly = (line: string): string =>
    withoutWikiMarkers(line)
        .replace(/`([^`]*)`/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*+]\s+/, "")
        .trim();

const bodyHit = (note: ParsedNote, needle: string): { hits: number; line: string | undefined } => {
    const lines = note.body.split(/\r?\n/);
    let hits = 0;
    let line: string | undefined;
    for (const candidate of lines) {
        if (candidate.toLowerCase().includes(needle)) {
            hits++;
            line ??= plainly(candidate);
        }
    }
    return { hits, line };
};

const scoreNote = (note: ParsedNote, needle: string): { score: number; matched: string; snippet: string | undefined } | undefined => {
    const title = note.title.toLowerCase();
    if (title === needle || note.slug.toLowerCase() === needle) {
        return { score: TITLE_EXACT, matched: "title", snippet: undefined };
    }
    if (note.aliases.some((alias) => alias.toLowerCase() === needle)) {
        return { score: ALIAS_EXACT, matched: "alias", snippet: undefined };
    }
    if (title.startsWith(needle)) {
        return { score: TITLE_PREFIX, matched: "title", snippet: undefined };
    }
    if (title.includes(needle) || note.slug.toLowerCase().includes(needle)) {
        return { score: TITLE_CONTAINS, matched: "title", snippet: undefined };
    }
    if (note.tags.includes(needle) || note.type?.toLowerCase() === needle) {
        return { score: TAG_OR_TYPE, matched: note.tags.includes(needle) ? "tag" : "type", snippet: undefined };
    }
    for (const [key, values] of factsOf(note)) {
        const value = values.find((candidate) => candidate.toLowerCase().includes(needle));
        if (value !== undefined) {
            return { score: FIELD, matched: "field", snippet: `${key}: ${value}` };
        }
    }
    const { hits, line } = bodyHit(note, needle);
    // Capped: past a point, more hits mean a longer note, not a more relevant one.
    return hits === 0 ? undefined : { score: BODY + Math.min(hits, 8), matched: "body", snippet: line };
};

export const search = (index: KnowledgeIndex, filters: SearchFilters): readonly SearchHit[] => {
    const needle = filters.query?.trim().toLowerCase() ?? "";
    const linkedTo = filters.linkedTo === undefined ? undefined : index.resolve(filters.linkedTo)?.path;
    const linked = linkedTo === undefined ? undefined : new Set((index.backlinks.get(linkedTo) ?? []).map((edge) => edge.from));
    const hits: SearchHit[] = [];
    for (const note of index.notes) {
        if (filters.type !== undefined && note.type?.toLowerCase() !== filters.type.toLowerCase()) {
            continue;
        }
        if (filters.tag !== undefined && !note.tags.includes(filters.tag.toLowerCase())) {
            continue;
        }
        if (linked !== undefined && !linked.has(note.path)) {
            continue;
        }
        // No query text means the filters are the query: every note that survives them, newest first.
        const scored = needle === "" ? { score: 0, matched: "all", snippet: undefined } : scoreNote(note, needle);
        if (scored === undefined) {
            continue;
        }
        hits.push({
            path: note.path,
            title: note.title,
            type: note.type,
            tags: note.tags,
            modifiedAt: note.modifiedAt,
            matched: scored.matched,
            snippet: scored.snippet,
            score: scored.score,
        });
    }
    // Recency breaks ties, so two equally-ranked notes surface the one being worked on.
    return hits
        .toSorted((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path))
        .slice(0, filters.limit ?? DEFAULT_LIMIT);
};

// The neighbourhood.

export interface GraphNode {
    readonly path: string;
    readonly title: string;
    readonly type: string | undefined;
    // Steps from the focus note; lets the picture fade the outer ring instead of drawing it flat.
    readonly depth: number;
}

export interface GraphView {
    readonly focus: string | undefined;
    readonly nodes: readonly GraphNode[];
    readonly edges: readonly NoteEdge[];
    // Neighbours that didn't fit the cap, said out loud rather than silently dropped.
    readonly omitted: number;
}

const MAX_NODES = 60;

// Everything within `depth` steps, links followed in both directions since connectivity doesn't care who holds the
// link. Breadth-first, so the cap trims the far ring, not an arbitrary branch; the first ring is always complete.
export const neighbourhood = (index: KnowledgeIndex, focus: string, depth: number): GraphView => {
    const start = index.resolve(focus) ?? index.byPath.get(focus);
    if (start === undefined) {
        return { focus: undefined, nodes: [], edges: [], omitted: 0 };
    }
    const seen = new Map<string, number>([[start.path, 0]]);
    let frontier = [start.path];
    let omitted = 0;
    for (let step = 1; step <= depth && frontier.length > 0; step++) {
        const next: string[] = [];
        for (const path of frontier) {
            const touching = [...(index.outgoing.get(path) ?? []), ...(index.backlinks.get(path) ?? [])];
            for (const edge of touching) {
                const other = edge.from === path ? edge.to : edge.from;
                if (other === undefined || seen.has(other)) {
                    continue;
                }
                if (seen.size >= MAX_NODES) {
                    omitted++;
                    continue;
                }
                seen.set(other, step);
                next.push(other);
            }
        }
        frontier = next;
    }
    const nodes = [...seen]
        .map(([path, depthOf]) => {
            const note = index.byPath.get(path);
            return { path, title: note?.title ?? path, type: note?.type, depth: depthOf };
        })
        .toSorted((a, b) => a.depth - b.depth || a.title.localeCompare(b.title));
    // Only edges between notes that made the cut; an edge to an undrawn node is a line into nothing.
    const edges = index.edges.filter((edge) => edge.to !== undefined && seen.has(edge.from) && seen.has(edge.to));
    return { focus: start.path, nodes, edges, omitted };
};
