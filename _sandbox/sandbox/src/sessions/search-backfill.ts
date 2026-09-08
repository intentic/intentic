import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { SearchIndex, SearchKind } from "./search-index.js";
import type { SpokenLine } from "./transcript-search.js";

// Fills the search index off the request path:
// - a first run or schema bump
// - turns recorded while the daemon was down
// - runtime sessions no turn of ours appends to
// Yields between sources so the daemon keeps serving; a source's version is one cheap stat (byte size, or size+mtime
// for sessions).

// Yielded between sources so a long backfill hums in the background instead of stalling the loop.
const YIELD_MS = 1;
// Logging cadence for an active backfill; a no-op pass (every pass after the first) stays silent.
const LOG_MS = 30_000;

export interface BackfillSource {
    readonly key: string;
    // Current version; undefined still counts as one, pinning an empty source as seen so it's not re-read.
    readonly version: () => Promise<string | undefined>;
    readonly lines: () => Promise<readonly SpokenLine[]>;
}

export interface BackfillRequest {
    readonly kind: SearchKind;
    readonly sources: readonly BackfillSource[];
    // True for sessions, whose unlisted entries are outside the window; false for conversations, pruned elsewhere.
    readonly prune: boolean;
}

export interface BackfillOutcome {
    readonly indexed: number;
    readonly skipped: number;
    readonly forgotten: number;
    readonly failed: number;
}

const NONE = "none";

// One pass; never rejects. A source that cannot be read costs only itself: it stays un-indexed and is retried next
// pass, rather than failing the whole sweep.
export const backfillSearchIndex = async (
    index: SearchIndex,
    request: BackfillRequest,
    logger: Logger,
    signal?: AbortSignal,
): Promise<BackfillOutcome> => {
    const known = index.versions(request.kind);
    const listed = new Set(request.sources.map((source) => source.key));
    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    let announcedAt = 0;
    const started = Date.now();

    for (const source of request.sources) {
        if (signal?.aborted === true) {
            break;
        }
        try {
            const version = (await source.version()) ?? NONE;
            if (known.get(source.key) === version) {
                skipped += 1;
                continue;
            }
            index.put(source.key, request.kind, version, await source.lines());
            indexed += 1;
            // Logs only once real work has happened, then at a human cadence, so quiet reading doesn't look silent.
            if (Date.now() - announcedAt > LOG_MS) {
                announcedAt = Date.now();
                logger.info({ kind: request.kind, indexed, of: request.sources.length }, "search index: backfilling");
            }
        } catch (error) {
            failed += 1;
            logger.warn({ err: error, kind: request.kind, key: source.key }, "search index: source not indexed");
        }
        await delay(YIELD_MS);
    }

    let forgotten = 0;
    if (request.prune) {
        for (const key of known.keys()) {
            if (!listed.has(key)) {
                index.forget(key);
                forgotten += 1;
            }
        }
    }

    // The closing line fires only for a pass that announced itself, so a steady-state no-op stays quiet.
    if (announcedAt > 0) {
        logger.info({ kind: request.kind, indexed, skipped, forgotten, failed, ms: Date.now() - started }, "search index: backfill complete");
    }
    return { indexed, skipped, forgotten, failed };
};
