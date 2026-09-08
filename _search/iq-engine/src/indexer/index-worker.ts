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

// Runs the index pass off the daemon's event loop: sweep, hashing, symbol extraction, chunking, SQLite writes and
// embedding are all CPU here, not the request path. The daemon holds a read-only handle for queries; every write
// happens on this side, two handles on one WAL file. Sequence numbers, not a dirty flag, tell the two sides when caught
// up.

export interface IndexWorkerData {
    readonly root: string;
    readonly indexDir: string;
    readonly modelDir: string | undefined;
}

// Daemon to worker; `seq` is monotonic, so a message arriving mid-pass only raises the target, a burst costs one extra
// pass.
export interface IndexWorkerRequest {
    readonly type: "dirty";
    readonly seq: number;
}

// Worker to daemon; `swept` lands before the index catches up, so queries filter against the current file list (with
// live rg hits) while parsing is still in flight.
export type IndexWorkerEvent =
    | { readonly type: "swept"; readonly entries: FileEntry[]; readonly sweepStart: number }
    | { readonly type: "indexed"; readonly generation: number; readonly seq: number }
    // How many chunks still lack a vector, published after each backlog slice; a cold index's only progress signal.
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

// Daemon already opened (and, on drift, recreated) this index before spawning the worker; only it deletes it.
const db = openIndex(indexDir, "write");
syncModel(db, modelDir);
// Sidecar lives outside indexDir, which openIndex drops on drift; undefined here disables only the cache.
const vectorCache = openVectorCache(vectorCachePath(indexDir), MODEL_ID);

let embedderPromise: Promise<Embedder | undefined> | undefined;
const getEmbedder = (): Promise<Embedder | undefined> => (embedderPromise ??= loadEmbedder(modelDir));

let requested = 0;
let applied = 0;
let draining = false;
let warmed = false;
// Generation the last pass wrote; `warmed` publishes later, once the backlog loop below actually finishes.
let lastGeneration = 0;

// Backlog drains in slices bounded by count and time, since either alone misbehaves; a sweep never waits long.
const EMBED_SLICE_CHUNKS = 512;
const EMBED_SLICE_MS = 3_000;

// Makes the index match disk; embedding is not here, so freshness never waits behind the backlog.
const pass = async (target: number): Promise<void> => {
    const sweepStart = Date.now();
    const entries = await sweep(root, false);
    post({ type: "swept", entries, sweepStart });
    const { generation } = await revalidate(db, entries, parseEntry);
    lastGeneration = generation;
    applied = target;
    post({ type: "indexed", generation, seq: applied });
};

// One bounded slice of the backlog; returns how many chunks still lack a vector. No model configured returns 0: an off
// semantic tier, not an empty backlog.
const embedSlice = async (): Promise<number> => {
    const embedder = await getEmbedder();
    if (embedder === undefined) {
        return 0;
    }
    return embedPending(db, embedder, vectorCache, EMBED_SLICE_CHUNKS, EMBED_SLICE_MS);
};

// One thing at a time, freshness first: each turn re-reads `requested`, so a notification mid-backlog is swept before
// the next slice. A failure leaves `applied` behind `requested`, reading honestly stale until retried.
const drain = async (): Promise<void> => {
    if (draining) {
        return;
    }
    draining = true;
    try {
        for (;;) {
            // Re-read only at the top of each round: a notification mid-pass raises `requested` for the next round.
            const target = requested;
            if (applied < target) {
                await pass(target);
                continue;
            }
            const remaining = await embedSlice();
            // Published even at 0: tells the daemon a watched backlog finished, or that a modelless host has none at
            // all.
            post({ type: "embedding", remaining });
            if (remaining === 0) {
                // Only once the backlog is gone; compacting between slices would vacuum every few hundred chunks of a
                // rebuild.
                compactIndex(db);
                vectorCache?.compact();
                // Warm means the semantic tier is ready, not just the first pass; querying earlier gets a silent BM25
                // answer.
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
