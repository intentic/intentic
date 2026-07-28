import { rmSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { WorkspaceSearchFreshness } from "@intentic/sandbox-contract";
import { type Embedder, loadEmbedder } from "./embed/embedder.js";
import { loadReranker, type Reranker } from "./embed/reranker.js";
import { type CodebaseHealth, codebaseHealth, type HealthRequest } from "./engines/health.js";
import { embedPending } from "./engines/semantic.js";
import type { IndexWorkerData, IndexWorkerEvent, IndexWorkerRequest } from "./indexer/index-worker.js";
import { revalidate, syncModel } from "./indexer/indexer.js";
import { parseEntry } from "./indexer/parse-entry.js";
import { openIndex } from "./store/db.js";
import { readIndexStatus } from "./store/index-store.js";
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

export interface ResidentEngineOptions extends EngineOptions {
    // An index pass that fails AFTER the first one has no other way out of the worker: warm() has long since
    // settled and no query is waiting on it. Without this seam the daemon's index would quietly stop tracking
    // disk with nothing in the log to say so.
    readonly onIndexError?: (error: Error) => void;
}

// A long-lived engine for hosts that serve other traffic (the sandbox daemon): one open DB, the sweep cached in
// memory, and revalidation driven by filesystem-change notifications instead of paid inline by every query.
export interface ResidentEngine {
    // Serves from the current in-memory sweep + index — no per-query sweep or revalidation. Awaits only the
    // FIRST sweep (a query before it has no admitted-paths authority to filter against). `signal` aborts
    // cancellable work (the rg child) when the caller's request dies.
    run(request: QueryRequest, signal?: AbortSignal): Promise<QueryOutcome>;
    // One repository's health in numbers (churn × complexity, index totals, the import graph's top modules) —
    // the same rankings `hotspots` and `map` render as text, for a host that plots them instead. Reads the same
    // resident sweep + index as run(), plus one `git log` per scoped repo.
    health(request: HealthRequest): Promise<CodebaseHealth>;
    // Filesystem changed — the worker picks it up; bursts coalesce into one extra pass.
    markDirty(): void;
    // Boot warmup: first index pass + the full embedding backlog. Queries may run concurrently throughout, and
    // so may everything else this process serves — none of it runs on this thread.
    warm(): Promise<IndexStatus>;
    // Stops the worker and releases the SQLite handle.
    close(): Promise<void>;
}

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
                        // Nothing indexes in the background here — the process exists for this one query — so
                        // `ask` filling embeddings inline is the only thing that ever advances semantic coverage.
                        topUpEmbeddings: true,
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
                return readIndexStatus(db, generation);
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

// The worker's entry is BUILT javascript in every form this module runs in: from `dist/index.js` the "../dist"
// hop is the identity, and from `src/index.ts` (this package's own tests) it steps across into the sibling build
// output — a raw worker thread has no TypeScript loader. That is why this package's `test` script builds first:
// the worker a test drives has to be this working tree's, not whatever was last compiled.
const WORKER_URL = new URL("../dist/indexer/index-worker.js", import.meta.url);

export const createResidentEngine = (options: ResidentEngineOptions): ResidentEngine => {
    const indexDir = options.indexDir ?? join(options.root, IQ_DIR);
    // Opened here, BEFORE the worker exists, because openIndex is the one operation that can delete and recreate
    // the index dir (schema drift, corruption) — two threads racing to do that would have one of them building
    // into a directory the other just unlinked. After this line the handle is READ-ONLY by convention: every
    // write to the index belongs to the worker, and WAL is what lets these queries run straight through its
    // writes instead of queueing behind them.
    const db = openIndex(indexDir);
    let embedderPromise: Promise<Embedder | undefined> | undefined;
    // Query-side inference only — one sentence per `ask`/`q`. The backlog's embedder lives in the worker, so the
    // model is resident on both threads; that is the deliberate trade, ~30 MB against a query that would
    // otherwise wait behind an indexing batch.
    const getEmbedder = (): Promise<Embedder | undefined> => (embedderPromise ??= loadEmbedder(options.modelDir));
    let rerankerPromise: Promise<Reranker | undefined> | undefined;
    const getReranker = (): Promise<Reranker | undefined> => (rerankerPromise ??= loadReranker(options.modelDir));

    let entries: FileEntry[] = [];
    let sweepStart = 0;
    let generation = 0;
    // True once the index has caught up with disk at least once — before that, queries report "building".
    let revalidatedOnce = false;
    // Monotonic change counter vs. the highest the worker has finished indexing. See the worker's header for why
    // freshness is a comparison of two numbers rather than a flag either side could clear at the wrong moment.
    let dirtySeq = 0;
    let appliedSeq = 0;

    // The sweep publishes before revalidation finishes, so the first query waits only for the file walk — it
    // searches against whatever index exists (rg hits are always live) while the parse/chunk pass catches up.
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
    // Both promises are created eagerly and may reject before anyone awaits them (a worker that dies on its very
    // first pass, with no query in flight and warm() not yet called). Claim them so that failure is reported
    // through onIndexError rather than as an unhandled rejection that takes the daemon down with it.
    void firstSweep.catch(() => undefined);
    void warmed.catch(() => undefined);

    // Holds the host process open until close(), like any other live handle — deliberately not unref'd, which
    // would let the process exit out from under a pass mid-write.
    const worker = new Worker(WORKER_URL, {
        workerData: { root: options.root, indexDir, modelDir: options.modelDir } satisfies IndexWorkerData,
    });

    // warm()'s promise IS the report channel until it settles — routing the first failure to onIndexError as
    // well would log one boot failure twice, under two different descriptions.
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
            return;
        }
        if (event.type === "warmed") {
            warmSettled = true;
            publishWarm(event.status);
            return;
        }
        fail(event.error);
    });
    // A pass that threw comes back as a `failed` message and leaves the worker alive to retry; reaching this is
    // the worker itself dying (OOM, a module that won't load), after which nothing will refresh the index again.
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
        async run(request, signal) {
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
                    // The worker drives the backlog to zero after every pass, so there is nothing for a query to
                    // top up — and an `ask` that spent its 2s embedding budget on this thread would be the exact
                    // stall the worker exists to prevent.
                    topUpEmbeddings: false,
                    features: options.features ?? new Set(FEATURES),
                    ...(options.rgPath !== undefined ? { rgPath: options.rgPath } : {}),
                    ...(signal !== undefined ? { signal } : {}),
                },
                request,
                entries,
            );
        },
        async health(request) {
            await firstSweep;
            return codebaseHealth({ db, root: options.root, freshness: freshness() }, request, entries);
        },
        markDirty() {
            dirtySeq += 1;
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads, not window: this postMessage takes no targetOrigin
            worker.postMessage({ type: "dirty", seq: dirtySeq } satisfies IndexWorkerRequest);
        },
        warm: () => warmed,
        async close() {
            // Terminated mid-write on purpose: WAL makes an interrupted transaction a rollback on next open, so
            // there is nothing to drain, and waiting out an embedding batch would hold up the daemon's shutdown.
            await worker.terminate();
            db.close();
        },
    };

    // The first pass is a change notification like any other, so the worker has exactly one way in and boot is
    // not a special case it could skip.
    engine.markDirty();
    return engine;
};
