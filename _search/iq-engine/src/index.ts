import { rmSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { WorkspaceSearchFreshness } from "@intentic/sandbox-contract";
import { type Embedder, loadEmbedder, MODEL_ID } from "./embed/embedder.js";
import { loadReranker, type Reranker } from "./embed/reranker.js";
import { openVectorCache, type VectorCache, vectorCachePath } from "./embed/vector-cache.js";
import { type CodebaseHealth, codebaseHealth, type HealthRequest } from "./engines/health.js";
import { embedPending } from "./engines/semantic.js";
import type { IndexWorkerData, IndexWorkerEvent, IndexWorkerRequest } from "./indexer/index-worker.js";
import { indexLag, revalidate, syncModel } from "./indexer/indexer.js";
import { parseEntry } from "./indexer/parse-entry.js";
import { inThreadScorer } from "./query/scorer.js";
import { workerScorer } from "./query/worker-scorer.js";
import { compactIndex, type IndexDb, isIndexBusy, openIndex } from "./store/db.js";
import { generationOf, readIndexStatus } from "./store/index-store.js";
import { claimIndexer, indexerAlive, releaseIndexer } from "./store/indexer-lock.js";
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
export type { CodebaseHealth, HealthRequest, HealthTotals, KeyModule } from "./engines/health.js";
export type { HotspotFile } from "./engines/hotspots.js";
export { impactOf } from "./engines/impact.js";
export type { ImpactDirection, ImpactedFile, ImpactOptions, ImpactResult } from "./engines/impact.js";
export { loadImportGraph } from "./engines/import-graph.js";
export type { ImportGraph } from "./engines/import-graph.js";
export { disabledOf, type Feature, FEATURES, parseFeatures } from "./features.js";
export { estimateTokens } from "./render/budget.js";
export { isIqDenied, IQ_DIR } from "./workspace/floor.js";
// The scope-filter glob dialect; exported so the daemon's rules and the search box narrow paths the same way.
export { globToRegExp } from "./workspace/glob.js";
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

export interface ResidentEngineOptions extends EngineOptions {
    // A later index-pass failure has no way out otherwise: warm() has settled, no query is waiting on it.
    readonly onIndexError?: (error: Error) => void;
    // Query worker died or refused a request; queries degrade to BM25 automatically, this is only for the log.
    readonly onQueryError?: (error: Error) => void;
    // Embedding backlog remaining after each slice; without it a long cold embed looks like a hung, busy machine.
    readonly onIndexProgress?: (remaining: number) => void;
}

export interface ResidentEngineMetrics {
    readonly files: number;
    readonly generation: number;
    readonly dirtySequence: number;
    readonly appliedSequence: number;
    readonly revalidated: boolean;
    readonly sweepAgeMs: number | undefined;
    // Chunks waiting for a vector; 0 means both complete coverage and no model, indistinguishable on purpose.
    readonly embedBacklog: number;
    readonly queryWorker: { readonly live: boolean; readonly pendingRequests: number };
}

// A long-lived engine for hosts serving other traffic: one open DB, the sweep cached in memory, revalidation driven by
// filesystem-change notifications instead of paid inline per query.
export interface ResidentEngine {
    // Serves from the current in-memory sweep + index; no per-query sweep, only the first sweep is awaited (before that
    // there's no admitted-paths authority). `signal` aborts the rg child when the caller's request dies.
    run(request: QueryRequest, signal?: AbortSignal): Promise<QueryOutcome>;
    // One repository's health in numbers, the same rankings `hotspots`/`map` render as text, for a host that plots
    // them. Reads the same resident sweep + index as run(), plus one `git log` per scoped repo.
    health(request: HealthRequest): Promise<CodebaseHealth>;
    // A git ref moved without changing workspace bytes; drops only the history-derived health cache, since a full index
    // pass would be unrelated work.
    invalidateHealth(): void;
    // Filesystem changed, the worker picks it up; bursts coalesce into one extra pass.
    markDirty(): void;
    // Boot warmup: first index pass plus the full embedding backlog; queries and everything else this process serves
    // may run concurrently, none of it on this thread.
    warm(): Promise<IndexStatus>;
    // Cheap resident-state cardinalities for the host's resource time series, read without walking the sweep or query
    // state again.
    metrics(): ResidentEngineMetrics;
    // Stops the worker and releases the SQLite handle.
    close(): Promise<void>;
}

// What a query can honestly say about the index it just searched: having revalidated it, "fresh" is a fact; having only
// read it, the answer is the file-level lag instead.
const freshnessOf = (db: IndexDb, entries: FileEntry[], sweepStart: number, wrote: boolean): WorkspaceSearchFreshness => {
    const ageMs = Date.now() - sweepStart;
    if (wrote) {
        return { state: "fresh", ageMs };
    }
    const lag = indexLag(db, entries);
    return lag === 0 ? { state: "fresh", ageMs } : { state: "stale", ageMs, progress: 1 - lag / Math.max(entries.length, 1), behind: lag };
};

export const createEngine = (options: EngineOptions): Engine => {
    const indexDir = options.indexDir ?? join(options.root, IQ_DIR);
    let embedderPromise: Promise<Embedder | undefined> | undefined;
    const getEmbedder = (): Promise<Embedder | undefined> => (embedderPromise ??= loadEmbedder(options.modelDir));
    let rerankerPromise: Promise<Reranker | undefined> | undefined;
    const getReranker = (): Promise<Reranker | undefined> => (rerankerPromise ??= loadReranker(options.modelDir));
    // Lazy like the models: only a write pays to open it. Lives outside indexDir, so indexDrop never clears it.
    let cacheOpened = false;
    let cacheHandle: VectorCache | undefined;
    const getCache = (): VectorCache | undefined => {
        if (!cacheOpened) {
            cacheOpened = true;
            cacheHandle = openVectorCache(vectorCachePath(indexDir), MODEL_ID);
        }
        return cacheHandle;
    };

    // Whether this process may write the index it's about to search: another owner means read-only, since two writers
    // on one SQLite file means SQLITE_BUSY for the loser. The sweep always happens read-only regardless.
    const opened = async (): Promise<{
        db: ReturnType<typeof openIndex>;
        generation: number;
        sweepStart: number;
        entries: Awaited<ReturnType<typeof sweep>>;
        indexed: boolean;
    }> => {
        const sweepStart = Date.now();
        const entries = await sweep(options.root, false);
        if (indexerAlive(indexDir)) {
            const db = openIndex(indexDir, "read");
            return { db, generation: generationOf(db), sweepStart, entries, indexed: false };
        }
        let db: ReturnType<typeof openIndex> | undefined;
        try {
            db = openIndex(indexDir, "write");
            const { generation } = await revalidate(db, entries, parseEntry);
            syncModel(db, options.modelDir);
            compactIndex(db);
            return { db, generation, sweepStart, entries, indexed: true };
        } catch (error) {
            if (!isIndexBusy(error)) {
                throw error;
            }
            // Whatever the write pass applied stays; this handle is dropped for a read-only one, refused the same way.
            db?.close();
            const reader = openIndex(indexDir, "read");
            return { db: reader, generation: generationOf(reader), sweepStart, entries, indexed: false };
        }
    };

    return {
        async run(request) {
            const { db, generation, sweepStart, entries, indexed } = await opened();
            try {
                return await dispatch(
                    {
                        root: options.root,
                        indexDir,
                        db,
                        generation,
                        freshness: freshnessOf(db, entries, sweepStart, indexed),
                        // In-thread: a one-shot process serves one query, so a worker would cost a second model load
                        // for nothing.
                        scorer: inThreadScorer({
                            db,
                            embedder: getEmbedder,
                            reranker: getReranker,
                            cache: getCache,
                            // Filled inline only here, since nothing indexes in the background; skipped if another owns
                            // the write lock.
                            topUpEmbeddings: indexed,
                        }),
                        features: request.features ?? options.features ?? new Set(FEATURES),
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
            const { db, generation } = await opened();
            try {
                return readIndexStatus(db, generation);
            } finally {
                db.close();
            }
        },
        async indexRebuild(onProgress) {
            // Dropping the dir under a live indexer leaves it writing into unlinked files and the workspace with no
            // index.
            if (indexerAlive(indexDir)) {
                throw new Error("another process owns this index (the sandbox daemon keeps it current): it cannot be rebuilt from here");
            }
            this.indexDrop();
            onProgress?.("rebuilding index from scratch");
            const { db, generation, entries } = await opened();
            try {
                onProgress?.(`indexed ${entries.length} files`);
                const embedder = await getEmbedder();
                if (embedder !== undefined) {
                    // Full embedding pass: the boot-time warmup path, no cap.
                    const remaining = await embedPending(db, embedder, getCache(), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
                    onProgress?.(remaining === 0 ? "embeddings complete" : `embeddings incomplete: ${remaining} chunks pending`);
                }
                return readIndexStatus(db, generation);
            } finally {
                db.close();
            }
        },
        indexDrop() {
            rmSync(indexDir, { recursive: true, force: true });
        },
    };
};

// Always the built JS in dist/, since a raw worker thread has no TypeScript loader.
const WORKER_URL = new URL("../dist/indexer/index-worker.js", import.meta.url);

export const createResidentEngine = (options: ResidentEngineOptions): ResidentEngine => {
    const indexDir = options.indexDir ?? join(options.root, IQ_DIR);
    // Opened before the worker: only this open may recreate the index dir; from here the handle only reads.
    const db = openIndex(indexDir, "write");
    // Claimed after the open that may recreate the dir, so the pid file isn't among what that open deletes.
    claimIndexer(indexDir);
    // Neither model loads on this thread; both live on the query worker, which answers the semantic scan and
    // cross-encoder for every query. Memory is unchanged, the same two models, one thread over.
    const scorer = workerScorer({
        indexDir,
        modelDir: options.modelDir,
        ...(options.onQueryError !== undefined ? { onError: options.onQueryError } : {}),
    });

    let entries: FileEntry[] = [];
    let sweepStart = 0;
    let generation = 0;
    // True once the index has caught up with disk at least once; before that, queries report "building".
    let revalidatedOnce = false;
    // Monotonic change counter, compared against the highest sequence the worker has finished indexing.
    let dirtySeq = 0;
    let appliedSeq = 0;
    // Last reading from the worker's backlog slices; 0 until one lands, also honest on a host with no model.
    let embedBacklog = 0;
    // Keyed by scope + churn window, not `limit`; the Promise value single-flights concurrent callers too.
    const healthCache = new Map<string, Promise<CodebaseHealth>>();
    const healthKeyOf = (request: HealthRequest): string =>
        JSON.stringify({
            paths: request.scope.paths,
            repo: request.scope.repo,
            langs: request.scope.langs,
            globs: request.scope.globs,
            notGlobs: request.scope.notGlobs,
            only: request.scope.only,
            ignored: request.scope.ignored,
            since: request.since,
        });
    const invalidateHealth = (): void => healthCache.clear();

    // Sweep publishes before revalidation finishes; the first query waits only for the file walk.
    let publishFirstSweep!: () => void;
    let failFirstSweep!: (error: Error) => void;
    const firstSweep = new Promise<void>((resolve, reject) => {
        publishFirstSweep = resolve;
        failFirstSweep = reject;
    });
    let publishWarm!: (status: IndexStatus) => void;
    let failWarm!: (error: Error) => void;
    const warmed = new Promise<IndexStatus>((resolve, reject) => {
        publishWarm = resolve;
        failWarm = reject;
    });
    // Claimed eagerly: a worker dying on its first pass, before any query or warm(), rejects unhandled otherwise.
    void firstSweep.catch(() => undefined);
    void warmed.catch(() => undefined);

    // Not unref'd: it holds the host process open until close(), or the process could exit mid-write.
    const worker = new Worker(WORKER_URL, {
        workerData: { root: options.root, indexDir, modelDir: options.modelDir } satisfies IndexWorkerData,
    });

    // warm()'s promise is the report channel until settled; routing its failure to onIndexError too logs it twice.
    let warmSettled = false;
    const fail = (error: Error): void => {
        if (warmSettled) {
            options.onIndexError?.(error);
        }
        warmSettled = true;
        failFirstSweep(error);
        failWarm(error);
    };

    worker.on("message", (event: IndexWorkerEvent) => {
        if (event.type === "swept") {
            entries = event.entries;
            sweepStart = event.sweepStart;
            publishFirstSweep();
            return;
        }
        if (event.type === "indexed") {
            generation = event.generation;
            appliedSeq = event.seq;
            revalidatedOnce = true;
            invalidateHealth();
            return;
        }
        if (event.type === "embedding") {
            embedBacklog = event.remaining;
            options.onIndexProgress?.(event.remaining);
            return;
        }
        if (event.type === "warmed") {
            warmSettled = true;
            publishWarm(event.status);
            return;
        }
        fail(event.error);
    });
    // A thrown pass arrives as a `failed` message, worker alive; this fires only when the worker itself dies.
    worker.on("error", fail);

    const freshness = (): WorkspaceSearchFreshness => {
        const ageMs = Date.now() - sweepStart;
        if (!revalidatedOnce) {
            return { state: "building", ageMs };
        }
        if (appliedSeq < dirtySeq) {
            return { state: "stale", ageMs };
        }
        return { state: "fresh", ageMs };
    };

    const engine: ResidentEngine = {
        metrics: () => ({
            files: entries.length,
            generation,
            dirtySequence: dirtySeq,
            appliedSequence: appliedSeq,
            revalidated: revalidatedOnce,
            sweepAgeMs: sweepStart === 0 ? undefined : Date.now() - sweepStart,
            embedBacklog,
            queryWorker: scorer.metrics(),
        }),
        async run(request, signal) {
            await firstSweep;
            return dispatch(
                {
                    root: options.root,
                    indexDir,
                    db,
                    generation,
                    freshness: freshness(),
                    scorer,
                    // Per-call features override the engine's own set: callers here have different deadline vs.
                    // rank-quality needs.
                    features: request.features ?? options.features ?? new Set(FEATURES),
                    ...(options.rgPath !== undefined ? { rgPath: options.rgPath } : {}),
                    ...(signal !== undefined ? { signal } : {}),
                },
                request,
                entries,
            );
        },
        async health(request) {
            await firstSweep;
            const key = healthKeyOf(request);
            let pending = healthCache.get(key);
            if (pending === undefined) {
                pending = codebaseHealth({ db, root: options.root, freshness: freshness() }, { ...request, limit: Number.MAX_SAFE_INTEGER }, entries);
                healthCache.set(key, pending);
                void pending.catch(() => {
                    if (healthCache.get(key) === pending) {
                        healthCache.delete(key);
                    }
                });
            }
            const full = await pending;
            return {
                ...full,
                hotspots: full.hotspots.slice(0, request.limit),
                modules: full.modules.slice(0, request.limit),
                freshness: freshness(),
            };
        },
        invalidateHealth,
        markDirty() {
            invalidateHealth();
            dirtySeq += 1;
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads, not window: this postMessage takes no targetOrigin
            worker.postMessage({ type: "dirty", seq: dirtySeq } satisfies IndexWorkerRequest);
        },
        warm: () => warmed,
        async close() {
            // Terminated mid-write on purpose: WAL rolls back an interrupted transaction on next open, so nothing needs
            // draining. The query worker only reads, so a search in flight is simply abandoned.
            await Promise.all([worker.terminate(), scorer.close()]);
            db.close();
            // Ownership ends here, so the next one-shot engine indexes inline again; a killed pid resolves to nothing.
            releaseIndexer(indexDir);
        },
    };

    // The first pass is a change notification like any other, so boot is not a special case the worker could skip.
    engine.markDirty();
    return engine;
};
