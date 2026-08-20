import { parentPort, workerData } from "node:worker_threads";
import type { Embedder } from "../embed/embedder.js";
import { loadEmbedder, MODEL_ID } from "../embed/embedder.js";
import { openVectorCache, vectorCachePath } from "../embed/vector-cache.js";
import { embedPending } from "../engines/semantic.js";
import { compactIndex, openIndex } from "../store/db.js";
import { readIndexStatus } from "../store/index-store.js";
import type { FileEntry, IndexStatus } from "../types.js";
import { sweep } from "../workspace/scan.js";
import { revalidate, syncModel } from "./indexer.js";
import { parseEntry } from "./parse-entry.js";

/* THE INDEX PASS, OFF THE DAEMON'S EVENT LOOP, the whole reason this file exists as a thread of its own.
 *
 * Keeping the index current is not expensive because of any one step; it is expensive because ALL of it is CPU
 * on the thread that runs it: the sweep's walk, sha256 per changed file, symbol extraction, chunking, a SQLite
 * transaction per file (node:sqlite is synchronous, there is no "await" that hands the loop back mid-write),
 * and then the embedding backlog. It does not block the host outright, the loop still turns between files,
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
 * reports a stale index as fresh, the one lie a search engine must not tell. */

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
    // How many chunks still have no vector, published after every slice of the backlog below. A cold index
    // makes this the ONLY sign that the thread is working rather than wedged, see the slice constants.
    | { readonly type: "embedding"; readonly remaining: number }
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
// this runs the directory is settled, only one thread is ever in a position to delete it.
const db = openIndex(indexDir, "write");
syncModel(db, modelDir);
// The vector sidecar deliberately does NOT live in indexDir: openIndex drops that dir on schema drift, and
// surviving exactly that drop is this cache's whole reason to exist. undefined (open failed twice) turns the
// cache off, never the semantic tier.
const vectorCache = openVectorCache(vectorCachePath(indexDir), MODEL_ID);

let embedderPromise: Promise<Embedder | undefined> | undefined;
const getEmbedder = (): Promise<Embedder | undefined> => (embedderPromise ??= loadEmbedder(modelDir));

let requested = 0;
let applied = 0;
let draining = false;
let warmed = false;
// The generation the last pass wrote, kept because `warmed` is published later than the pass that earned it,
// see the backlog loop below, which is what has to finish before warm-up is honestly over.
let lastGeneration = 0;

/* THE EMBEDDING BACKLOG IS DRAINED IN SLICES, WHICH IS WHAT KEEPS THE INDEX FRESH WHILE IT DRAINS.
 *
 * A cold index, one just rebuilt, or the first boot on which a model is actually present, has every chunk in
 * the workspace waiting for a vector. On this repo that is 66k chunks and roughly half an hour of CPU.
 *
 * Drained as ONE uncapped embedPending call (which is what this used to do), that half hour sits INSIDE a pass,
 * and the loop below never reaches the top to re-read `requested`. So no second sweep runs, `applied` stays
 * where the first pass left it, and every change notification piles up behind work that has nothing to do with
 * them. Measured on a live sandbox: 84 notifications queued, `applied` stuck at 1, and the last completed sweep
 * receding to the age of the process, a state indistinguishable, from the outside, from a hung worker. It is
 * the single most expensive thing this file can get wrong, because the symptom names the wrong culprit.
 *
 * Sliced, the loop comes back to the top between batches: freshness is never more than one slice behind, and
 * the backlog resumes right after the sweep it yielded to. Identical total work on the identical thread.
 *
 * The slice is bounded by BOTH a chunk count and a time budget because either alone misbehaves, a run of very
 * large chunks blows the latency of a count-only slice, and a nearly-empty backlog spins through a time-only
 * one. The time budget is what actually binds during a cold build (~150 chunks at the 4-thread rate), so a
 * sweep waiting behind the backlog waits seconds, not the rest of the rebuild. */
const EMBED_SLICE_CHUNKS = 512;
const EMBED_SLICE_MS = 3_000;

// The half of a pass that makes the index match disk. Embedding is deliberately NOT here: this is what
// freshness depends on, and it must never be stuck behind the backlog.
const pass = async (target: number): Promise<void> => {
    const sweepStart = Date.now();
    const entries = await sweep(root, false);
    post({ type: "swept", entries, sweepStart });
    const { generation } = await revalidate(db, entries, parseEntry);
    lastGeneration = generation;
    applied = target;
    post({ type: "indexed", generation, seq: applied });
};

// One bounded slice of the backlog; answers how many chunks still have no vector. No model configured (or none
// present in the image) is not a backlog, it is a semantic tier that stays off, and 0 says so.
const embedSlice = async (): Promise<number> => {
    const embedder = await getEmbedder();
    if (embedder === undefined) {
        return 0;
    }
    return embedPending(db, embedder, vectorCache, EMBED_SLICE_CHUNKS, EMBED_SLICE_MS);
};

// One thing at a time on this thread, FRESHNESS FIRST. Each turn re-reads `requested`, so a notification that
// arrives mid-backlog is swept before the next slice rather than after the last one. A failure abandons the rest
// and reports, `applied` stays behind `requested`, so the daemon keeps reading "stale" (honest) and the next
// change notification retries.
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
            if (applied < target) {
                await pass(target);
                continue;
            }
            const remaining = await embedSlice();
            // Published even at 0: it is what tells the daemon a backlog it was watching has finished, and on a
            // host with no model it is the steady state rather than a missing reading.
            post({ type: "embedding", remaining });
            if (remaining === 0) {
                // Only once the backlog is gone, compaction between slices would pay a full incremental vacuum
                // for every few hundred chunks of a rebuild.
                compactIndex(db);
                vectorCache?.compact();
                /* WARM MEANS THE SEMANTIC TIER IS ACTUALLY THERE, which is why it is published HERE and not at
                 * the end of the first pass. Slicing the backlog made that tempting, the index answers for
                 * what is on disk long before the vectors exist, but a caller that awaits warm() and then
                 * queries is asking for the whole engine, and resolving early hands it a BM25-only answer with
                 * no way to tell that is what it got. A host that wants the earlier signal has `indexed`.
                 * On a host with no model the backlog is empty on the first look, so this still settles at the
                 * end of the first pass, the semantic tier being off is not warm-up still running. */
                if (!warmed) {
                    warmed = true;
                    post({ type: "warmed", status: readIndexStatus(db, lastGeneration) });
                }
                return;
            }
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
