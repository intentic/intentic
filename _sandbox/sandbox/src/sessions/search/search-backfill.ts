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
// How long a pass runs before it says how far it got, and then how often. A pass is short whenever little is behind,
// which is every pass but a first one or a rebuild: each re-reads the one or two records a running turn just grew, and
// logged both a start and an end line at info for it, 578 and 577 of them in one daemon.log. Those now go to debug.
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
    // Told after every source how many of them the pass has been through, so a search answered mid-pass can say how
    // much of the index it read.
    readonly progress?: (done: number, of: number) => void;
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
    const known = await index.versions(request.kind);
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
            await index.put(source.key, request.kind, version, await source.lines());
            indexed += 1;
            // Only a pass long enough to be waited on says how far it got, then at a human cadence.
            const now = Date.now();
            if (now - started > LOG_MS && now - announcedAt > LOG_MS) {
                announcedAt = now;
                logger.info({ kind: request.kind, indexed, skipped, of: request.sources.length }, "search index: backfilling");
            }
        } catch (error) {
            failed += 1;
            logger.warn({ err: error, kind: request.kind, key: source.key }, "search index: source not indexed");
        } finally {
            request.progress?.(indexed + skipped + failed, request.sources.length);
        }
        await delay(YIELD_MS);
    }

    let forgotten = 0;
    if (request.prune) {
        for (const key of known.keys()) {
            if (!listed.has(key)) {
                await index.forget(key);
                forgotten += 1;
            }
        }
    }

    // At info only for a pass that announced itself; a short one that changed something is a debug line, and a no-op
    // pass says nothing at all.
    const outcome = { kind: request.kind, indexed, skipped, forgotten, failed, ms: Date.now() - started };
    if (announcedAt > 0) {
        logger.info(outcome, "search index: backfill complete");
    } else if (indexed + forgotten + failed > 0) {
        logger.debug(outcome, "search index: backfill complete");
    }
    return { indexed, skipped, forgotten, failed };
};
