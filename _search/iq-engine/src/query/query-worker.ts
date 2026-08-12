import { parentPort, workerData } from "node:worker_threads";
import { loadEmbedder } from "../embed/embedder.js";
import { loadReranker } from "../embed/reranker.js";
import { semanticSearch } from "../engines/semantic.js";
import { openIndex } from "../store/db.js";
import type { EngineHit } from "../types.js";

/* ANSWERING A QUERY, OFF THE HOST'S EVENT LOOP — the counterpart to index-worker.ts, and the half that was
 * missing. That one moved the work of KEEPING the index current; this one moves the work of READING it.
 *
 * The daemon's thread used to run both model stages of every natural-language query itself. Measured against
 * this workspace's index (3.7k files, 58k chunks): ~300ms for the scan over every embedded chunk, ~400ms for
 * the cross-encoder over the 24 candidates, and the loop blocked for essentially all of both — node:sqlite is
 * synchronous, so the scan cannot yield, and transformers.js tokenizes in JS before ONNX ever sees the batch.
 * Agents search on every turn, so that is ~700ms of dead loop per turn on the thread that streams their output.
 *
 * The cost was already being paid in a feature that was switched off rather than shipped: turn-context ran
 * WITHOUT the cross-encoder because on a busy box the full pipeline missed its 3s deadline 71% of the time —
 * 104 of 133 turns computed a better answer and threw it away. That trade is what this thread buys back.
 *
 * READ-ONLY, and that is the whole concurrency story. The index worker writes; this side and the host only
 * read; WAL lets all three hold the file at once. Nothing here is stateful between requests either, so requests
 * need no ordering and no queue — each message is answered on its own, and `id` is what pairs an answer with
 * its question.
 *
 * The models load at startup rather than on first use. The host spawns this thread at boot, next to the index
 * worker, so the half-second of model loading overlaps the first index pass instead of landing on whoever
 * searches first — which, before this file existed, was a first query that paid it on the daemon's own thread. */

export interface QueryWorkerData {
    readonly indexDir: string;
    readonly modelDir: string | undefined;
}

// Host → worker. `id` is the caller's correlation number; the worker only echoes it.
export type QueryWorkerRequest =
    | { readonly type: "semantic"; readonly id: number; readonly query: string; readonly allowed: string[] }
    | { readonly type: "rerank"; readonly id: number; readonly query: string; readonly passages: string[] };

// Worker → host. "absent" is not a failure: a host with no baked model dir is a supported configuration, and
// the pipeline degrades to BM25 (semantic) or to the fused order (rerank) and says so.
export type QueryWorkerResponse =
    | { readonly type: "semantic"; readonly id: number; readonly hits: EngineHit[]; readonly pending: number }
    | { readonly type: "rerank"; readonly id: number; readonly scores: number[] }
    | { readonly type: "absent"; readonly id: number }
    | { readonly type: "failed"; readonly id: number; readonly error: string };

const port = parentPort;
if (port === null) {
    throw new Error("iq query worker: not started as a worker thread");
}

const { indexDir, modelDir } = workerData as QueryWorkerData;

const db = openIndex(indexDir, "read");
const embedderReady = loadEmbedder(modelDir);
const rerankerReady = loadReranker(modelDir);

const answer = async (request: QueryWorkerRequest): Promise<QueryWorkerResponse> => {
    const { id } = request;
    if (request.type === "semantic") {
        const embedder = await embedderReady;
        if (embedder === undefined) {
            return { type: "absent", id };
        }
        // Counted here rather than on the host: it is one more read of the same index this thread already has
        // open, and the only reason the host wants the number is to print "embeddings 87%" beside the results.
        const pending = Number(db.get("SELECT COUNT(*) AS n FROM chunks WHERE embedded = 0")?.["n"] ?? 0);
        const hits = semanticSearch(db, await embedder.embedQuery(request.query), new Set(request.allowed));
        return { type: "semantic", id, hits, pending };
    }
    const reranker = await rerankerReady;
    if (reranker === undefined) {
        return { type: "absent", id };
    }
    return { type: "rerank", id, scores: await reranker.rerank(request.query, request.passages) };
};

port.on("message", (request: QueryWorkerRequest) => {
    void answer(request).then(
        (response) => {
            port.postMessage(response);
        },
        (error: unknown) => {
            // Per-request failure, reported per-request: a query that hits a bad passage or a broken model call
            // degrades that one answer, and the thread stays up for the next one.
            port.postMessage({ type: "failed", id: request.id, error: error instanceof Error ? error.message : String(error) });
        },
    );
});
