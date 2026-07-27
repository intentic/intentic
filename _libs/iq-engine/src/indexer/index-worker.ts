import { parentPort, workerData } from "node:worker_threads";
import type { Embedder } from "../embed/embedder.js";
import { loadEmbedder } from "../embed/embedder.js";
import { embedPending } from "../engines/semantic.js";
import { openIndex } from "../store/db.js";
import { readIndexStatus } from "../store/index-store.js";
import type { FileEntry, IndexStatus } from "../types.js";
import { sweep } from "../workspace/scan.js";
import { revalidate, syncModel } from "./indexer.js";
import { parseEntry } from "./parse-entry.js";

/* THE INDEX PASS, OFF THE DAEMON'S EVENT LOOP — the whole reason this file exists as a thread of its own.
 *
 * Keeping the index current is not expensive because of any one step; it is expensive because ALL of it is CPU
 * on the thread that runs it: the sweep's walk, sha256 per changed file, symbol extraction, chunking, a SQLite
 * transaction per file (node:sqlite is synchronous — there is no "await" that hands the loop back mid-write),
 * and then the embedding backlog. It does not block the host outright — the loop still turns between files —
 * it SATURATES it, which is worse for being harder to see: a request does not stop, it just waits out whichever
 * slice is running, once per turn it needs. Measured on a real sandbox mid-warm-up: the daemon's loop thread
 * ran 83% busy for 13 minutes, and browser requests behind it took 3 to 14 seconds, 0.4 kB reads included.
 *
 * Here, none of that is on the request path. The daemon's thread keeps one READ-ONLY handle for queries; every
 * write to the index (model sync, revalidation, embeddings) happens on this side. Two handles on one SQLite
 * file is exactly what WAL is for: readers never block on the writer, and openIndex sets busy_timeout for the
 * rare moment a checkpoint needs the file to itself.
 *
 * SEQUENCE NUMBERS, not a dirty flag, are how the two threads agree on "caught up". The daemon stamps every
 * change notification with a monotonic seq and this side echoes back the highest one it has fully indexed; the
 * daemon compares the two to answer freshness. A flag would have to be cleared on the daemon's side without
 * knowing whether the pass that just finished had actually seen the change that set it, which is a race that
 * reports a stale index as fresh — the one lie a search engine must not tell. */

export interface IndexWorkerData {
    readonly root: string;
    readonly indexDir: string;
    readonly modelDir: string | undefined;
}

// Daemon → worker. `seq` is monotonic; a message that arrives mid-pass only raises the target, so a burst of
// changes costs one extra pass rather than one pass each.
export interface IndexWorkerRequest {
    readonly type: "dirty";
    readonly seq: number;
}

// Worker → daemon. `swept` lands BEFORE the index catches up on purpose: the file list is what a query filters
// against, so publishing it early lets queries run against the current tree (with rg hits, which are always
// live) while parsing is still in flight, exactly as the in-thread engine used to.
export type IndexWorkerEvent =
    | { readonly type: "swept"; readonly entries: FileEntry[]; readonly sweepStart: number }
    | { readonly type: "indexed"; readonly generation: number; readonly seq: number }
    | { readonly type: "warmed"; readonly status: IndexStatus }
    | { readonly type: "failed"; readonly error: Error };

const port = parentPort;
if (port === null) {
    throw new Error("iq index worker: not started as a worker thread");
}

const { root, indexDir, modelDir } = workerData as IndexWorkerData;

const post = (event: IndexWorkerEvent): void => {
    port.postMessage(event);
};

// The daemon opened (and, on schema drift, dropped and recreated) this index before spawning us, so by the time
// this runs the directory is settled — only one thread is ever in a position to delete it.
const db = openIndex(indexDir);
syncModel(db, modelDir);

let embedderPromise: Promise<Embedder | undefined> | undefined;
const getEmbedder = (): Promise<Embedder | undefined> => (embedderPromise ??= loadEmbedder(modelDir));

let requested = 0;
let applied = 0;
let draining = false;
let warmed = false;

const pass = async (target: number): Promise<void> => {
    const sweepStart = Date.now();
    const entries = await sweep(root, false);
    post({ type: "swept", entries, sweepStart });
    const { generation } = await revalidate(db, entries, parseEntry);
    applied = target;
    post({ type: "indexed", generation, seq: applied });
    // The embedding backlog, uncapped — this thread has nothing else to do, and a complete backlog is what lets
    // the query path drop its own inline top-up (see dispatch's topUpEmbeddings).
    const embedder = await getEmbedder();
    if (embedder !== undefined) {
        await embedPending(db, embedder, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    }
    if (!warmed) {
        warmed = true;
        post({ type: "warmed", status: readIndexStatus(db, generation) });
    }
};

// One pass at a time. A failure abandons the rest of the queue and reports — `applied` stays behind `requested`,
// so the daemon keeps reading "stale" (honest) and the next change notification retries.
const drain = async (): Promise<void> => {
    if (draining) {
        return;
    }
    draining = true;
    try {
        for (;;) {
            // Re-read at the TOP of each round, and never inside a pass: `target` is what that pass can honestly
            // claim to have seen, and a notification landing mid-pass raises `requested` so this loop runs again
            // rather than folding the change into a pass that had already swept past it.
            const target = requested;
            if (applied >= target) {
                return;
            }
            await pass(target);
        }
    } catch (error) {
        post({ type: "failed", error: error instanceof Error ? error : new Error(String(error)) });
    } finally {
        draining = false;
    }
};

port.on("message", (request: IndexWorkerRequest) => {
    requested = Math.max(requested, request.seq);
    void drain();
});
