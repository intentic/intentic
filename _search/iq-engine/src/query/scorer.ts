import type { Embedder } from "../embed/embedder.js";
import type { Reranker } from "../embed/reranker.js";
import type { VectorCache } from "../embed/vector-cache.js";
import { embedPending, semanticSearch } from "../engines/semantic.js";
import type { IndexDb } from "../store/db.js";
import type { EngineHit } from "../types.js";

export interface SemanticOutcome {
    readonly hits: EngineHit[];
    // Count of chunks without a vector yet; 0 is full coverage.
    readonly pending: number;
}

// The two model-bearing stages of a query, behind an interface since where they run is the host's choice: the CLI runs
// them in-thread for a single query, the daemon offloads them so blocking doesn't stall its other work.
export interface QueryScorer {
    // Top semantic hits for `query` restricted to `allowed`; undefined when the host has no embedding model, and `ask`
    // falls back to BM25.
    semantic(query: string, allowed: ReadonlySet<string>): Promise<SemanticOutcome | undefined>;
    // Cross-encoder logit per passage, in passage order; undefined when no reranker is present, so the fused order
    // stands.
    rerank(query: string, passages: readonly string[]): Promise<number[] | undefined>;
}

export interface InThreadScorerOptions {
    // Passed per query since the one-shot engine may reopen the handle each run; models are held instead.
    readonly db: IndexDb;
    readonly embedder: () => Promise<Embedder | undefined>;
    readonly reranker: () => Promise<Reranker | undefined>;
    // True if a query may spend its own latency filling NULL embeddings; false when an indexer owns that backlog.
    readonly topUpEmbeddings: boolean;
    // Vector sidecar, consulted only when topping up; a getter so only a topping-up query pays to open it.
    readonly cache: () => VectorCache | undefined;
}

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
