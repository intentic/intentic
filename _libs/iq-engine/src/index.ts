import { rmSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceSearchFreshness } from "@intentic/sandbox-contract";
import { type Embedder, loadEmbedder, MODEL_ID } from "./embed/embedder.js";
import { loadReranker, type Reranker } from "./embed/reranker.js";
import { embedPending } from "./engines/semantic.js";
import { chunkFile } from "./indexer/chunker.js";
import { type ParseFile, revalidate } from "./indexer/indexer.js";
import { extractSymbols } from "./indexer/symbols.js";
import { type IndexDb, openIndex } from "./store/db.js";
import { getMeta, setMeta } from "./store/index-store.js";
import type { FileEntry, IndexStatus, QueryOutcome, QueryRequest } from "./types.js";
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

// A long-lived engine for in-process hosts (the sandbox daemon): one open DB, the sweep cached in memory, and
// revalidation driven by filesystem-change notifications instead of paid inline by every query.
export interface ResidentEngine {
    // Serves from the current in-memory sweep + index — no per-query sweep or revalidation. Awaits only the
    // FIRST sweep (a query before it has no admitted-paths authority to filter against). `signal` aborts
    // cancellable work (the rg child) when the caller's request dies.
    run(request: QueryRequest, signal?: AbortSignal): Promise<QueryOutcome>;
    // Filesystem changed — schedule a refresh (debounced; serialized with any refresh in flight).
    markDirty(): void;
    // Boot warmup: first refresh + the full embedding backlog. Queries may run concurrently throughout.
    warm(): Promise<IndexStatus>;
    // Releases the SQLite handle. Async because it must first drain any in-flight refresh: a fire-and-forget
    // revalidate writes to the db, and closing it mid-write throws ERR_INVALID_STATE ("database is not open").
    close(): Promise<void>;
}

const parseEntry: ParseFile = (path, lang, content) => {
    const symbols = extractSymbols(path, lang, content);
    return { symbols, chunks: chunkFile(path, symbols, content) };
};

// A model swap invalidates every stored vector, never the chunks themselves.
const syncModel = (db: IndexDb, modelDir: string | undefined): void => {
    if (modelDir === undefined) {
        return;
    }
    if (getMeta(db, "model_id") !== MODEL_ID) {
        db.run("UPDATE chunks SET embedding = NULL");
        setMeta(db, "model_id", MODEL_ID);
    }
};

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
        const { generation } = await revalidate(db, entries, parseEntry);
        syncModel(db, options.modelDir);
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
                        freshness: { state: "fresh", ageMs: Date.now() - sweepStart },
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

// One refresh fires this long after the FIRST markDirty of a window (not reset per event), so index lag stays
// bounded while an agent edits continuously. The daemon's watcher already coalesces bursts ahead of this.
const REFRESH_DEBOUNCE_MS = 300;

export const createResidentEngine = (options: EngineOptions): ResidentEngine => {
    const indexDir = options.indexDir ?? join(options.root, IQ_DIR);
    const db = openIndex(indexDir);
    syncModel(db, options.modelDir);
    let embedderPromise: Promise<Embedder | undefined> | undefined;
    const getEmbedder = (): Promise<Embedder | undefined> => (embedderPromise ??= loadEmbedder(options.modelDir));
    let rerankerPromise: Promise<Reranker | undefined> | undefined;
    const getReranker = (): Promise<Reranker | undefined> => (rerankerPromise ??= loadReranker(options.modelDir));

    let entries: FileEntry[] = [];
    let sweepStart = 0;
    let generation = 0;
    // True once the index has caught up with disk at least once — before that, queries report "building".
    let revalidatedOnce = false;
    let dirty = true;
    let refreshing: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // The sweep publishes before revalidation runs, so the first query waits only for the file walk — it
    // searches against whatever index exists (rg hits are always live) while the parse/chunk pass catches up.
    let publishFirstSweep!: () => void;
    const firstSweep = new Promise<void>((resolve) => {
        publishFirstSweep = resolve;
    });

    // Serialized: one revalidation at a time; changes arriving mid-refresh set `dirty` and the loop re-runs.
    const refresh = (): Promise<void> =>
        (refreshing ??= (async () => {
            try {
                do {
                    dirty = false;
                    const started = Date.now();
                    entries = await sweep(options.root, false);
                    sweepStart = started;
                    publishFirstSweep();
                    ({ generation } = await revalidate(db, entries, parseEntry));
                    revalidatedOnce = true;
                } while (dirty);
            } finally {
                refreshing = undefined;
            }
        })());

    const freshness = (): WorkspaceSearchFreshness => {
        const ageMs = Date.now() - sweepStart;
        if (!revalidatedOnce) {
            return { state: "building", ageMs };
        }
        if (dirty || refreshing !== undefined) {
            return { state: "stale", ageMs };
        }
        return { state: "fresh", ageMs };
    };

    return {
        async run(request, signal) {
            // Self-heals a missed change notification chain: the first query after boot always has a refresh.
            if (dirty && refreshing === undefined) {
                void refresh();
            }
            await firstSweep;
            return dispatch(
                {
                    root: options.root,
                    indexDir,
                    db,
                    generation,
                    freshness: freshness(),
                    getEmbedder,
                    getReranker,
                    features: options.features ?? new Set(FEATURES),
                    ...(options.rgPath !== undefined ? { rgPath: options.rgPath } : {}),
                    ...(signal !== undefined ? { signal } : {}),
                },
                request,
                entries,
            );
        },
        markDirty() {
            dirty = true;
            if (refreshing !== undefined) {
                return;
            }
            timer ??= setTimeout(() => {
                timer = undefined;
                if (dirty) {
                    void refresh();
                }
            }, REFRESH_DEBOUNCE_MS);
        },
        async warm() {
            await refresh();
            const embedder = await getEmbedder();
            if (embedder !== undefined) {
                // Full embedding pass, uncapped — in-process, so queries interleave instead of contending.
                await embedPending(db, embedder, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
            }
            return status(db, generation);
        },
        async close() {
            clearTimeout(timer);
            // A refresh started by run()/markDirty is fire-and-forget and may still be revalidating into the db.
            // Closing the handle out from under that write throws "database is not open" — drain it first.
            await refreshing;
            db.close();
        },
    };
};
