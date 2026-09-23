import type { MatchSnippet } from "@intentic/sandbox-contract";
import { siblingModule, workerCalls } from "../worker-calls.js";
import type { SpokenLine } from "./transcript-search.js";

// What was said, indexed durably and written forward as turns settle, so a search reads only this, never the
// transcripts. The SQLite work runs on a worker thread (search-store.ts, search-index-worker.ts): a cold-cache query
// measured 2.2 s and a backfill put 1.3 s, and on the daemon's own loop either one froze every terminal and stream.

// A conversation (fleet board) or a runtime session (history list); kept apart so neither route pays for the other's
// rows.
export type SearchKind = "conversation" | "session";

export interface SearchIndexMetrics {
    readonly conversations: number;
    readonly sessions: number;
    readonly lines: number;
}

export interface SearchIndex {
    // Replaces everything indexed for one source; the backfill's and a rewind's verb, cheaper than reconciling.
    readonly put: (key: string, kind: SearchKind, version: string, lines: readonly SpokenLine[]) => Promise<void>;
    // Appends a settled turn's lines, the hot path; append-only, so nothing is read back before writing.
    readonly extend: (key: string, kind: SearchKind, version: string, lines: readonly SpokenLine[]) => Promise<void>;
    // What each source of this kind was last indexed at, for a backfill to diff against the stores.
    readonly versions: (kind: SearchKind) => Promise<Map<string, string>>;
    // Drop a source entirely: a purged conversation, a session whose file is gone.
    readonly forget: (key: string) => Promise<void>;
    // Oldest user line wins, else oldest agent's, one row per source; folds `needle` to match the ingest fold.
    readonly search: (needle: string, kind: SearchKind, caseSensitive: boolean) => Promise<Map<string, MatchSnippet>>;
    // The counts the worker reported with its last write, so the resource sampler reads them without a round trip.
    readonly metrics: () => SearchIndexMetrics;
    readonly close: () => Promise<void>;
}

// One question for the worker; the channel adds the `id` that pairs it with its answer.
export type SearchAsk =
    | { readonly op: "put" | "extend"; readonly key: string; readonly kind: SearchKind; readonly version: string; readonly lines: readonly SpokenLine[] }
    | { readonly op: "forget"; readonly key: string }
    | { readonly op: "versions"; readonly kind: SearchKind }
    | { readonly op: "search"; readonly needle: string; readonly kind: SearchKind; readonly caseSensitive: boolean }
    | { readonly op: "close" };

export const openSearchIndex = (dir: string): SearchIndex => {
    let latest: SearchIndexMetrics = { conversations: 0, sessions: 0, lines: 0 };
    // The worker reports fresh counts with every write's answer and once on opening.
    const calls = workerCalls<SearchAsk, SearchIndexMetrics>(siblingModule(import.meta, "search-index-worker"), { dir }, (metrics) => {
        latest = metrics;
    });
    return {
        put: (key, kind, version, lines) => calls.call({ op: "put", key, kind, version, lines }),
        extend: (key, kind, version, lines) => calls.call({ op: "extend", key, kind, version, lines }),
        versions: (kind) => calls.call({ op: "versions", kind }),
        forget: (key) => calls.call({ op: "forget", key }),
        search: (needle, kind, caseSensitive) => calls.call({ op: "search", needle, kind, caseSensitive }),
        metrics: () => latest,
        close: async () => {
            await calls.call({ op: "close" });
            await calls.close();
        },
    };
};
