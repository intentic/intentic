import { parentPort, workerData } from "node:worker_threads";
import { errorMessage } from "@intentic/base/errors";
import { loadEmbedder } from "../embed/embedder.js";
import { loadReranker } from "../embed/reranker.js";
import { semanticSearch } from "../engines/semantic.js";
import { openIndex } from "../store/db.js";
import type { EngineHit } from "../types.js";

// Answers queries off the host's event loop. index-worker.ts writes the index; this thread only reads, so WAL lets both
// hold it open at once. Each request is independent; `id` pairs the answer with its question. Models load at startup,
// overlapping the first index pass instead of the first query.

export interface QueryWorkerData {
    readonly indexDir: string;
    readonly modelDir: string | undefined;
}

// Host → worker. `id` is the caller's correlation number; the worker only echoes it.
export type QueryWorkerRequest =
    | { readonly type: "semantic"; readonly id: number; readonly query: string; readonly allowed: string[] }
    | { readonly type: "rerank"; readonly id: number; readonly query: string; readonly passages: string[] };

// Worker → host. `absent` isn't a failure: no baked model dir degrades semantic search to BM25 and rerank to the fused
// order.
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
        // Counted here since only this thread holds the index open; the host cannot query it directly.
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
            // A failed request reports its own error; the thread stays alive for the next one.
            port.postMessage({ type: "failed", id: request.id, error: errorMessage(error) });
        },
    );
});
