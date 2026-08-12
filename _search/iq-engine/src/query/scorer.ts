import type { Embedder } from "../embed/embedder.js";
import type { Reranker } from "../embed/reranker.js";
import type { VectorCache } from "../embed/vector-cache.js";
import { embedPending, semanticSearch } from "../engines/semantic.js";
import type { IndexDb } from "../store/db.js";
import type { EngineHit } from "../types.js";

export interface SemanticOutcome {
    readonly hits: EngineHit[];
    // Chunks still without a vector, for the provenance note ("embeddings 87%"). 0 = full coverage.
    readonly pending: number;
}

/* THE TWO MODEL-BEARING STAGES OF A NATURAL-LANGUAGE QUERY, behind an interface because WHERE they run is a
 * property of the host, not of the pipeline.
 *
 * Everything else `ask` does is either milliseconds (BM25 over an FTS index, fusion, rendering) or someone
 * else's thread (rg is a child process). These two are neither. Measured against this workspace's own index —
 * 3.7k files, 58k chunks — one query spends ~300ms scanning every embedded chunk and ~400ms in the
 * cross-encoder, and BOTH hold the thread they run on for essentially all of it: node:sqlite is synchronous and
 * transformers.js does its tokenizing in JS.
 *
 * For the `iq` CLI that is free — the process exists for this one query and has nothing else to serve, so a
 * worker would only add a thread and a model load to pay for. For the daemon it is the whole problem: 700ms
 * with no yield, on the thread that also streams every agent's turn, serves the browser, and runs the routes.
 * Hence one interface and two implementations, chosen by whoever builds the engine. */
export interface QueryScorer {
    // Top semantic hits for `query`, restricted to `allowed`. undefined when this host has no embedding model,
    // which is a supported configuration — `ask` says so and answers from BM25 alone.
    semantic(query: string, allowed: ReadonlySet<string>): Promise<SemanticOutcome | undefined>;
    // Cross-encoder logits, one per passage, order matching. undefined when no reranker is present: the fused
    // order stands.
    rerank(query: string, passages: readonly string[]): Promise<number[] | undefined>;
}

export interface InThreadScorerOptions {
    // The handle this query is being served from. Passed per query rather than held, because the one-shot
    // engine opens (and sometimes reopens read-only) a handle per run, while the models outlive all of them.
    readonly db: IndexDb;
    readonly embedder: () => Promise<Embedder | undefined>;
    readonly reranker: () => Promise<Reranker | undefined>;
    // Whether a query may spend part of its own latency filling NULL embeddings. True for the one-shot CLI,
    // where a query is the only thing that ever runs and so the only thing that can advance coverage; false
    // wherever an indexer owns the backlog.
    readonly topUpEmbeddings: boolean;
    // The persistent vector sidecar, consulted only when topping up. A getter for the same reason the models
    // are: only the query that actually tops up should pay the open.
    readonly cache: () => VectorCache | undefined;
}

// Runs both stages on the caller's thread.
export const inThreadScorer = (options: InThreadScorerOptions): QueryScorer => ({
    async semantic(query, allowed) {
        const embedder = await options.embedder();
        if (embedder === undefined) {
            return undefined;
        }
        const pending = options.topUpEmbeddings
            ? await embedPending(options.db, embedder, options.cache())
            : Number(options.db.get("SELECT COUNT(*) AS n FROM chunks WHERE embedded = 0")?.["n"] ?? 0);
        return { hits: semanticSearch(options.db, await embedder.embedQuery(query), allowed), pending };
    },
    async rerank(query, passages) {
        const reranker = await options.reranker();
        return reranker === undefined ? undefined : reranker.rerank(query, passages);
    },
});
