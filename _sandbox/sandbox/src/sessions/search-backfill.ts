import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { SearchIndex, SearchKind } from "./search-index.js";
import type { SpokenLine } from "./transcript-search.js";

/* FILLING THE SEARCH INDEX, off the request path.
 *
 * The index is written forward by settling turns, so in steady state there is nothing for this to do. It
 * exists for the three ways the index can fall behind what the stores hold:
 *
 *   - a FIRST RUN, or a schema bump, where the index is empty and everything said in the workspace is behind it
 *   - turns recorded while this daemon was NOT running (a crash mid-append, a restart, a rebuild)
 *   - the runtime sessions, which no turn of ours appends to: they are the SDK's own files, so the only way to
 *     know one moved is to look at it
 *
 * DETACHED AND PACED, deliberately. On the sandbox this was measured against, a first run reads 545 MB of
 * transcript records and up to 124 MB of session files; done in a tight loop that is seconds of blocked event
 * loop, which is the exact failure this whole change exists to remove, just moved from the query to the boot.
 * So it yields between sources and the daemon serves requests throughout. A search that runs while it is still
 * working answers from what is indexed so far, which is why the routes report their own coverage rather than
 * implying completeness (see agents.routes.ts search).
 *
 * VERSIONS, not timestamps or hashes. A conversation's version is its record's byte size (the record is
 * append-only plus rewind's truncate, so any change moves it); a session's is size and mtime together. Both are
 * one stat, which is what makes "is this still current" affordable for every source at once.
 */

// Between sources, so a long backfill is a background hum rather than a stall. One tick is enough: the read
// and the insert are the work, and this hands the loop back between each one.
const YIELD_MS = 1;
// A backfill that is actually doing something says so on this cadence, and only then. A no-op pass (which is
// every pass after the first) stays silent. Same argument as the iq backlog logging in composition.ts: work
// nobody named reads as a wedged daemon.
const LOG_MS = 30_000;

export interface BackfillSource {
    readonly key: string;
    // What this source is at right now. `undefined` ⇒ nothing stored for it yet, which is still a version: it
    // pins the source as "seen and empty" so an empty conversation is not re-read on every pass.
    readonly version: () => Promise<string | undefined>;
    readonly lines: () => Promise<readonly SpokenLine[]>;
}

export interface BackfillRequest {
    readonly kind: SearchKind;
    readonly sources: readonly BackfillSource[];
    /* Whether a key the index holds but this pass did not list should be dropped. True for sessions, whose set
     * is the window the history route can return, so anything outside it is dead weight that can never be
     * answered with. False for conversations: the roster is the caller's own list, and a pass that raced a
     * registry reload must not take the archive's rows out with it. Purging is the purge path's job
     * (purgeConversationState), which knows the difference between "not listed" and "gone". */
    readonly prune: boolean;
}

export interface BackfillOutcome {
    readonly indexed: number;
    readonly skipped: number;
    readonly forgotten: number;
    readonly failed: number;
}

const NONE = "none";

/* One pass. Never rejects: a source that cannot be read costs itself and not the pass, the same rule the
 * record's own row parsing applies. A source that fails is simply left un-indexed and retried next pass, which
 * is the honest outcome, its words are missing from the filter until it can be read. */
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
            // Announce only once the pass has proved it is doing real work, and then at a human cadence. A
            // first run on a large workspace is minutes of quiet disk reading otherwise.
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
