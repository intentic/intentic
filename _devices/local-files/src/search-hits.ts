import type { WorkspaceSearchGroup, WorkspaceSearchHit, WorkspaceSearchSpan } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";

// What both engines of a folder's search answer in (search.ts): ripgrep's (search-rg.ts) and the folder read here
// (search-read.ts). Lines are kept and cut as the daemon's engine keeps them (iq-engine), so a match reads the same
// whichever side found it.

// The bounds of one search: files looked at, matching lines kept, and the wall clock, read off `now`.
export interface SearchBounds {
    readonly scanned: number;
    readonly hits: number;
    readonly budgetMs: number;
    readonly now: () => number;
}
export const SEARCH_BOUNDS: SearchBounds = { scanned: 100_000, hits: 5_000, budgetMs: 15_000, now: Date.now };

// Which bound stopped a search before it had looked at everything.
export type Cut = `files` | `matches` | `time`;

// Every file's matching lines, best first, and the bound that stopped the search, if one did.
export interface Found {
    readonly groups: readonly WorkspaceSearchGroup[];
    readonly cut?: Cut | undefined;
}

// Lines kept per file.
export const MAX_PER_FILE = 50;
// A file past this is data, not text anyone searches by hand.
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
// A long line is shipped as the part around its first match, spans rebased onto it.
const SNIPPET_MAX = 200;
const SNIPPET_LEAD = 40;

// One matching line as the page carries it: a long line cut around its first match, the spans that survive the cut
// rebased onto it.
export const hitOf = (line: number, text: string, spans: readonly WorkspaceSearchSpan[]): WorkspaceSearchHit => {
    const tags: WorkspaceSearchHit[`tags`] = [{ kind: `text` }];
    if (text.length <= SNIPPET_MAX) {
        return { line, text, spans: [...spans], tags };
    }
    const from = Math.max(0, (spans[0]?.start ?? 0) - SNIPPET_LEAD);
    const to = from + SNIPPET_MAX;
    const kept = spans.filter((span) => span.start >= from && span.end <= to).map((span) => ({ start: span.start - from, end: span.end - from }));
    return { line, text: text.slice(from, to), spans: kept, tags };
};

// A file's lines as a group, or undefined for none; `capped` when it had more than were kept.
export const groupOf = (path: string, hits: WorkspaceSearchHit[], capped: boolean): WorkspaceSearchGroup | undefined => {
    if (hits.length === 0) {
        return undefined;
    }
    const group: WorkspaceSearchGroup = { path, score: hits.length, hits };
    if (capped) {
        group.capped = true;
    }
    return group;
};

// Most matching lines first, then by path: the order every page of one answer keeps.
export const byMatches = (a: WorkspaceSearchGroup, b: WorkspaceSearchGroup): number => b.score - a.score || (a.path < b.path ? -1 : 1);
