import type { VaultEdge, VaultIndex } from "./index-vault.js";
import { factsOf, type VaultNote } from "./note.js";

/* ASKING THE VAULT THINGS — search, filter, and the neighbourhood around one note.
 *
 * The ranking is deliberately explainable rather than clever, and there is no second retrieval engine behind
 * it. A vault is a few hundred short notes the owner or the agent WROTE, so what someone types is nearly always
 * the name of a thing they know is in there — and for that, "the note actually called that, then the note that
 * says it goes by that, then the notes that mention it" is both the best answer and the one a reader can
 * predict. Fuzzy prose search over the same folder is already a tool the agent has (`iq`), and pointing it here
 * costs nothing; duplicating it worse is what this deliberately does not do. */

export interface SearchFilters {
    readonly query?: string | undefined;
    readonly type?: string | undefined;
    readonly tag?: string | undefined;
    // Notes that link to this one (by any relation) — "everything about the Intentic project".
    readonly linkedTo?: string | undefined;
    readonly limit?: number | undefined;
}

export interface SearchHit {
    readonly path: string;
    readonly title: string;
    readonly type: string | undefined;
    readonly tags: readonly string[];
    readonly modifiedAt: number;
    // Why this note is in the answer, in one word, so a surprising hit explains itself: title, alias, tag,
    // type, field, or body.
    readonly matched: string;
    // The evidence — the line the body matched on, or the fact that did. Absent for a name match, where the
    // title the reader is looking at IS the evidence.
    readonly snippet: string | undefined;
    readonly score: number;
}

const DEFAULT_LIMIT = 50;

// Tiers, not a formula. The gap between them is wide enough that no amount of body matching promotes a note
// over one that is actually named what was asked for.
const TITLE_EXACT = 1000;
const ALIAS_EXACT = 900;
const TITLE_PREFIX = 700;
const TITLE_CONTAINS = 500;
const TAG_OR_TYPE = 300;
/* A note's plain facts are searchable, and they have to be: a header field is where a knowledge note keeps the
 * thing you would actually go looking by — an employer, a city, a version. Those words appear nowhere in the
 * prose, so a search that read only the body would answer "no such note" about a note that says it plainly. */
const FIELD = 200;
const BODY = 100;

/* A matched line as EVIDENCE rather than as source. It is shown under a title in a narrow column, where
 * `**client-generated**` and `[[Checkout API]]` read as damage rather than as emphasis and a link — the markers
 * mean something only to a renderer, and this is not one. The words are left exactly as written; only the
 * punctuation that was never meant to be read comes off. */
const plainly = (line: string): string =>
    line
        .replace(/\[\[([^\][|]+)(?:\|([^\]]+))?\]\]/g, (_all, target: string, label?: string) => (label ?? target).trim())
        .replace(/`([^`]*)`/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*+]\s+/, "")
        .trim();

const bodyHit = (note: VaultNote, needle: string): { hits: number; line: string | undefined } => {
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

const scoreNote = (note: VaultNote, needle: string): { score: number; matched: string; snippet: string | undefined } | undefined => {
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
    // Capped: a note that says the word thirty times is more relevant than one that says it twice, and no more
    // relevant than one that says it eight times — past that it is a long note, not a better answer.
    return hits === 0 ? undefined : { score: BODY + Math.min(hits, 8), matched: "body", snippet: line };
};

export const search = (index: VaultIndex, filters: SearchFilters): readonly SearchHit[] => {
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
        // No words to match on means the filters ARE the query — every note that survives them, newest first.
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
    // Recency breaks ties, so two equally-named notes present the one being worked on.
    return hits
        .toSorted((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path))
        .slice(0, filters.limit ?? DEFAULT_LIMIT);
};

// ---- the neighbourhood ------------------------------------------------------------------------------------

export interface GraphNode {
    readonly path: string;
    readonly title: string;
    readonly type: string | undefined;
    // How many steps from the focus note — what lets the picture fade the outer ring rather than draw it flat.
    readonly depth: number;
}

export interface GraphView {
    readonly focus: string | undefined;
    readonly nodes: readonly GraphNode[];
    readonly edges: readonly VaultEdge[];
    // Neighbours that did not fit the cap. Said out loud rather than silently dropped: a map that quietly
    // omits half the graph is worse than one that admits it.
    readonly omitted: number;
}

const MAX_NODES = 60;

/* Everything within `depth` steps of one note, links followed in BOTH directions — because "what is connected
 * to this" does not care which note happens to hold the link. Breadth-first, so the cap cuts the far ring
 * rather than an arbitrary branch, and the first ring is always complete. */
export const neighbourhood = (index: VaultIndex, focus: string, depth: number): GraphView => {
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
    // Only edges between notes that made the cut — an edge to a node nobody drew is a line into nothing.
    const edges = index.edges.filter((edge) => edge.to !== undefined && seen.has(edge.from) && seen.has(edge.to));
    return { focus: start.path, nodes, edges, omitted };
};
