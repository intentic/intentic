import { rmSync } from "node:fs";
import { join } from "node:path";
import { type Embedder, loadEmbedder } from "./embed/embedder.js";
import { loadReranker, type Reranker } from "./embed/reranker.js";
import { embedPending } from "./engines/semantic.js";
import { chunkFile } from "./indexer/chunker.js";
import { revalidate } from "./indexer/indexer.js";
import { extractSymbols } from "./indexer/symbols.js";
import { type IndexDb, openIndex } from "./store/db.js";
import { getMeta, setMeta } from "./store/index-store.js";
import type { IndexStatus, QueryOutcome, QueryRequest } from "./types.js";
import { type Feature, FEATURES } from "./features.js";
import { dispatch } from "./verbs/dispatch.js";
import { IQ_DIR } from "./workspace/floor.js";
import { sweep } from "./workspace/scan.js";

export type {
    EngineHit,
    EngineResult,
    FileClass,
    FileEntry,
    IndexStatus,
    QueryOutcome,
    QueryRequest,
    RankedGroup,
    RankedHit,
    RenderOptions,
    Scope,
    SymbolRow,
    Verb,
    VerbOptions,
} from "./types.js";
export { disabledOf, type Feature, FEATURES, parseFeatures } from "./features.js";
export { estimateTokens } from "./render/budget.js";
export { isIqDenied, IQ_DIR } from "./workspace/floor.js";
export { canonicalLang } from "./workspace/scan.js";

export interface EngineOptions {
    readonly root: string;
    readonly indexDir?: string;
    readonly rgPath?: string;
    readonly modelDir?: string;
    // Retrieval-stage toggles (benchmarking); absent = all stages on. Build with parseFeatures().
    readonly features?: ReadonlySet<Feature>;
}

export interface Engine {
    run(request: QueryRequest): Promise<QueryOutcome>;
    indexStatus(): Promise<IndexStatus>;
    indexRebuild(onProgress?: (message: string) => void): Promise<IndexStatus>;
    indexDrop(): void;
}

const status = (db: IndexDb, generation: number): IndexStatus => {
    const count = (sql: string): number => Number(db.get(sql)?.["n"] ?? 0);
    return {
        files: count("SELECT COUNT(*) AS n FROM files"),
        symbols: count("SELECT COUNT(*) AS n FROM symbols"),
        chunks: count("SELECT COUNT(*) AS n FROM chunks"),
        embedded: count("SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL"),
        generation,
        freshness: { state: "fresh", ageMs: 0 },
    };
};

export const createEngine = (options: EngineOptions): Engine => {
    const indexDir = options.indexDir ?? join(options.root, IQ_DIR);
    let embedderPromise: Promise<Embedder | undefined> | undefined;
    const getEmbedder = (): Promise<Embedder | undefined> => (embedderPromise ??= loadEmbedder(options.modelDir));
    let rerankerPromise: Promise<Reranker | undefined> | undefined;
    const getReranker = (): Promise<Reranker | undefined> => (rerankerPromise ??= loadReranker(options.modelDir));

    const revalidated = async (): Promise<{
        db: ReturnType<typeof openIndex>;
        generation: number;
        sweepStart: number;
        entries: Awaited<ReturnType<typeof sweep>>;
    }> => {
        const sweepStart = Date.now();
        const entries = await sweep(options.root, false);
        const db = openIndex(indexDir);
        const { generation } = await revalidate(db, entries, (path, lang, content) => {
            const symbols = extractSymbols(path, lang, content);
            return { symbols, chunks: chunkFile(path, symbols, content) };
        });
        // A model swap invalidates every stored vector, never the chunks themselves.
        if (options.modelDir !== undefined) {
            const { MODEL_ID } = await import("./embed/embedder.js");
            if (getMeta(db, "model_id") !== MODEL_ID) {
                db.run("UPDATE chunks SET embedding = NULL");
                setMeta(db, "model_id", MODEL_ID);
            }
        }
        return { db, generation, sweepStart, entries };
    };

    return {
        async run(request) {
            const { db, generation, sweepStart, entries } = await revalidated();
            try {
                return await dispatch(
                    {
                        root: options.root,
                        indexDir,
                        db,
                        generation,
                        sweepStart,
                        getEmbedder,
                        getReranker,
                        features: options.features ?? new Set(FEATURES),
                        ...(options.rgPath !== undefined ? { rgPath: options.rgPath } : {}),
                    },
                    request,
                    entries,
                );
            } finally {
                db.close();
            }
        },
        async indexStatus() {
            const { db, generation } = await revalidated();
            try {
                return status(db, generation);
            } finally {
                db.close();
            }
        },
        async indexRebuild(onProgress) {
            this.indexDrop();
            onProgress?.("rebuilding index from scratch");
            const { db, generation, entries } = await revalidated();
            try {
                onProgress?.(`indexed ${entries.length} files`);
                const embedder = await getEmbedder();
                if (embedder !== undefined) {
                    // Full embedding pass — this is the boot-time warmup path, no cap.
                    const remaining = await embedPending(db, embedder, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
                    onProgress?.(remaining === 0 ? "embeddings complete" : `embeddings incomplete: ${remaining} chunks pending`);
                }
                return status(db, generation);
            } finally {
                db.close();
            }
        },
        indexDrop() {
            rmSync(indexDir, { recursive: true, force: true });
        },
    };
};
