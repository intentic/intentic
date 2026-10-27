import { randomUUID } from "node:crypto";
import { anySignal, sleep } from "@intentic/base/async";
import { findText, TEXT_MAX_HITS, type TextFind } from "@intentic/iq-engine/text";
import type {
    WorkspaceSearchFrame,
    WorkspaceSearchGroup,
    WorkspaceSearchResult,
} from "@intentic/sandbox-contract/schemas/workspace/workspace-search";

// The search box's text search (workspace.search with `mode` find, and its stream): ripgrep run from the daemon itself
// (iq-engine's text-search.ts), at the daemon's own priority, rather than inside the iq engine child, which runs niced as
// a background service, shares its one process with every turn's context lookups and the embedding worker, and after
// ten idle minutes has to be started again before it answers. Its slow searches measured 10 to 20 s on 2026-10-26 while
// ripgrep alone took 20 to 100 ms over the same tree.
//
// One scan answers every page: it runs in parallel to the end of the tree (or TEXT_MAX_HITS lines), its files sorted by
// path, and the answer is kept for a while so Load more is a slice of it rather than another scan whose answer may have
// moved since.

// Answers kept for their later pages: few, briefly, and bounded by the lines they hold, since every keystroke keeps one.
const KEPT_ANSWERS = 6;
const KEPT_MS = 5 * 60_000;
const KEPT_HITS = 3 * TEXT_MAX_HITS;
// How long found files gather before a stream sends them: a search that finishes inside it sends its answer alone.
const STREAM_BATCH_MS = 40;

export interface TextPage {
    readonly hits: number;
    readonly files: number;
}

export interface TextQuery {
    readonly root: string;
    readonly query: string;
    readonly literal: boolean;
    readonly word: boolean;
    readonly caseSensitive: boolean;
    readonly ignored: boolean;
    // Root-relative subtrees the caller may search (a fence, the open project); undefined is everything.
    readonly paths: readonly string[] | undefined;
    readonly globs: readonly string[];
    readonly notGlobs: readonly string[];
    readonly page: TextPage;
    // The cursor of a page before, naming the kept answer and where the next page starts.
    readonly after: string | undefined;
}

// How an answer was come by, for its perf line.
export interface TextTiming {
    // A later page served from a kept answer: no scan ran.
    readonly kept: boolean;
    readonly scanMs: number | undefined;
    readonly firstMs: number | undefined;
    readonly ceiling: boolean;
}

export interface TextAnswer {
    readonly result: WorkspaceSearchResult;
    readonly timing: TextTiming;
}

export interface TextSearch {
    readonly find: (query: TextQuery, signal?: AbortSignal, onGroup?: (group: WorkspaceSearchGroup) => void) => Promise<TextAnswer>;
}

interface Kept {
    readonly key: string;
    readonly at: number;
    readonly hits: number;
    readonly found: TextFind;
}

// Everything that changes which lines answer: two cursors may share a kept answer only if this matches.
const keyOf = (query: TextQuery): string =>
    JSON.stringify([
        query.root,
        query.query,
        query.literal,
        query.word,
        query.caseSensitive,
        query.ignored,
        query.paths,
        query.globs,
        query.notGlobs,
    ]);

const hitsIn = (groups: readonly WorkspaceSearchGroup[]): number => groups.reduce((sum, group) => sum + group.hits.length, 0);

// A cursor is `<answer>.<offset>`; anything else starts from the first page.
const cursorOf = (after: string | undefined): { readonly id: string; readonly offset: number } | undefined => {
    const match = /^([\w-]+)\.(\d+)$/u.exec(after ?? "");
    return match?.[1] === undefined || match[2] === undefined ? undefined : { id: match[1], offset: Number(match[2]) };
};

// One page of an answer: its files, and the lines among them.
interface PageSlice {
    readonly groups: WorkspaceSearchGroup[];
    readonly shown: number;
}

// The page starting at `offset`: whole files only, so a file never shows with some of its lines; the first is always in.
const pageOf = (groups: readonly WorkspaceSearchGroup[], offset: number, page: TextPage): PageSlice => {
    const shown: WorkspaceSearchGroup[] = [];
    let hits = 0;
    for (const group of groups.slice(offset)) {
        if (shown.length > 0 && (shown.length >= page.files || hits + group.hits.length > page.hits)) {
            break;
        }
        shown.push(group);
        hits += group.hits.length;
    }
    return { groups: shown, shown: hits };
};

// What the answer says beside its lines: what was done unasked, where the ceiling cut it, a file that could not be read.
const noteOf = (found: TextFind): string | undefined => {
    const parts = [
        found.note,
        found.ceiling
            ? `stopped at ${TEXT_MAX_HITS.toLocaleString("en")} matching lines, the first found; narrow the search for the rest`
            : undefined,
        found.unreadable === undefined ? undefined : `not every file could be read: ${found.unreadable}`,
    ].filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : parts.join(" · ");
};

const resultOf = (id: string, found: TextFind, offset: number, page: TextPage): WorkspaceSearchResult => {
    const { groups, shown } = pageOf(found.groups, offset, page);
    const next = offset + groups.length;
    const result: WorkspaceSearchResult = {
        mode: "find",
        total: hitsIn(found.groups),
        files: found.groups.length,
        shown,
        groups,
        // Read from the disk as it is now: no index stands between the answer and the files.
        freshness: { state: "fresh", ageMs: 0 },
        truncated: next < found.groups.length,
    };
    if (found.ceiling || found.groups.some((group) => group.capped === true)) {
        result.partial = true;
    }
    if (next < found.groups.length) {
        result.cursor = `${id}.${next}`;
    }
    const note = noteOf(found);
    if (note !== undefined) {
        result.note = note;
    }
    return result;
};

export const createTextSearch = ({ rgPath, now = Date.now }: { readonly rgPath: string | undefined; readonly now?: () => number }): TextSearch => {
    const kept = new Map<string, Kept>();
    const keep = (key: string, found: TextFind): string => {
        const id = randomUUID();
        kept.set(id, { key, at: now(), hits: hitsIn(found.groups), found });
        // A Map iterates oldest first; the answer just kept is never the one dropped.
        let held = [...kept.values()].reduce((sum, entry) => sum + entry.hits, 0);
        for (const [old, entry] of kept) {
            if (old === id) {
                break;
            }
            if (kept.size > KEPT_ANSWERS || held > KEPT_HITS || now() - entry.at > KEPT_MS) {
                kept.delete(old);
                held -= entry.hits;
            }
        }
        return id;
    };
    return {
        find: async (query, signal, onGroup) => {
            const key = keyOf(query);
            const cursor = cursorOf(query.after);
            const held = cursor === undefined ? undefined : kept.get(cursor.id);
            if (cursor !== undefined && held !== undefined && held.key === key && now() - held.at <= KEPT_MS) {
                return {
                    result: resultOf(cursor.id, held.found, cursor.offset, query.page),
                    timing: { kept: true, scanMs: undefined, firstMs: undefined, ceiling: held.found.ceiling },
                };
            }
            const from = performance.now();
            const found = await findText({
                root: query.root,
                pattern: query.query,
                literal: query.literal,
                word: query.word,
                caseSensitive: query.caseSensitive,
                ignored: query.ignored,
                paths: query.paths,
                globs: query.globs,
                notGlobs: query.notGlobs,
                rgPath,
                signal,
                onGroup,
            });
            // A cursor whose answer was let go is served from a fresh scan, at the offset it asked for.
            const id = keep(key, found);
            return {
                result: resultOf(id, found, cursor?.offset ?? 0, query.page),
                timing: { kept: false, scanMs: performance.now() - from, firstMs: found.firstMs, ceiling: found.ceiling },
            };
        },
    };
};

// Where a stream's search stands: still running, answered, or failed.
interface StreamOutcome {
    answer?: TextAnswer;
    error?: Error;
    settled: boolean;
}

// A text search as a stream: the files found so far, gathered for a moment and at most a page of them, then the answer.
// Leaving the stream early (the box typed on) stops the scan.
export async function* streamText(
    search: TextSearch,
    query: TextQuery,
    signal: AbortSignal | undefined,
    onAnswer: (answer: TextAnswer) => void,
): AsyncGenerator<WorkspaceSearchFrame> {
    const stop = new AbortController();
    const pending: WorkspaceSearchGroup[] = [];
    // What has been taken for the provisional list, sent or still gathering.
    let files = 0;
    let hits = 0;
    let wake: (() => void) | undefined;
    const nudge = (): void => {
        const waiting = wake;
        wake = undefined;
        waiting?.();
    };
    const onGroup = (group: WorkspaceSearchGroup): void => {
        // Past a page the provisional list stops growing: the answer that replaces it is a page too.
        if (files >= query.page.files || hits + group.hits.length > query.page.hits) {
            return;
        }
        files += 1;
        hits += group.hits.length;
        pending.push(group);
        nudge();
    };
    const outcome: StreamOutcome = { settled: false };
    const running = (async (): Promise<void> => {
        try {
            outcome.answer = await search.find(query, anySignal(signal, stop.signal), onGroup);
        } catch (error) {
            outcome.error = error instanceof Error ? error : new Error(String(error));
        }
        outcome.settled = true;
        nudge();
    })();
    try {
        for (;;) {
            if (outcome.settled) {
                break;
            }
            if (pending.length === 0) {
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
                continue;
            }
            // Found files gather for a moment, so a fast tree sends one frame rather than one per file.
            await Promise.race([running, sleep(STREAM_BATCH_MS, { unref: true })]);
            if (!outcome.settled) {
                yield { kind: "groups", groups: pending.splice(0) };
            }
        }
        if (outcome.answer === undefined) {
            throw outcome.error ?? new Error("text search ended without an answer");
        }
        onAnswer(outcome.answer);
        yield { kind: "done", result: outcome.answer.result };
    } finally {
        stop.abort();
    }
}
