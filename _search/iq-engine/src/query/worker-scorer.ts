import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { packageRoot } from "@intentic/constants/node";
import type { QueryWorkerData, QueryWorkerRequest, QueryWorkerResponse } from "./query-worker.js";
import type { QueryScorer } from "./scorer.js";

// Built javascript, for the same reason index.ts spawns its indexer that way: a raw worker thread has no
// TypeScript loader, so from `src/` this steps across into the sibling build output and from `dist/` it is the
// identity. This package's `test` script builds first so a test drives this working tree's worker.
const WORKER_URL = pathToFileURL(join(packageRoot(import.meta.url), "dist/query/query-worker.js"));

export interface WorkerScorerOptions {
    readonly indexDir: string;
    readonly modelDir: string | undefined;
    // The thread died (OOM, a model that won't load). Queries in flight degrade and the next one respawns it,
    // so this is a log line rather than a decision — but an unreported death would mean semantic search quietly
    // stopped happening, which is the one thing a search engine must not do silently.
    readonly onError?: (error: Error) => void;
}

export interface WorkerScorer extends QueryScorer {
    metrics(): { readonly live: boolean; readonly pendingRequests: number };
    close(): Promise<void>;
}

/* The daemon's side of query-worker.ts: spawn it, correlate answers to questions, and survive its death.
 *
 * NO IN-THREAD FALLBACK, deliberately. A worker dies when the box is out of memory or the model is broken, and
 * "run the 700ms of inference here instead" would put the stall back on the daemon's loop at the exact moment
 * the machine can least afford it. A dead worker degrades the query the way a host with no model dir already
 * does — BM25 alone, and the capsule says so — and the next query gets a fresh thread. */
export const workerScorer = (options: WorkerScorerOptions): WorkerScorer => {
    const pending = new Map<number, (response: QueryWorkerResponse | undefined) => void>();
    let worker: Worker | undefined;
    let nextId = 0;
    let closed = false;

    // Settles everything in flight as "no answer" — callers degrade rather than hang.
    const settleAll = (): void => {
        const waiting = [...pending.values()];
        pending.clear();
        for (const settle of waiting) {
            settle(undefined);
        }
    };

    // The worker reference is dropped with the requests, so the next one spawns a fresh thread instead of
    // posting into a dead port.
    const abandon = (dead: Worker, error: Error): void => {
        if (worker === dead) {
            worker = undefined;
        }
        settleAll();
        options.onError?.(error);
    };

    const live = (): Worker => {
        if (worker !== undefined) {
            return worker;
        }
        // Not unref'd: a request in flight must keep the process alive to answer, and a host that exits with
        // the promise unsettled would look like a query that simply never came back.
        const spawned = new Worker(WORKER_URL, {
            workerData: { indexDir: options.indexDir, modelDir: options.modelDir } satisfies QueryWorkerData,
        });
        spawned.on("message", (response: QueryWorkerResponse) => {
            const settle = pending.get(response.id);
            pending.delete(response.id);
            settle?.(response);
        });
        spawned.on("error", (error: Error) => {
            abandon(spawned, error);
        });
        spawned.on("exit", () => {
            // Only reachable for an exit nobody asked for — close() drops the reference before terminating.
            if (worker === spawned) {
                abandon(spawned, new Error("iq query worker exited"));
            }
        });
        worker = spawned;
        return spawned;
    };

    // Spawned now, not on the first query: loading both models takes ~570ms off a warm page cache and more off
    // a cold one, and at construction time that overlaps the host's boot (the index worker's first pass)
    // instead of landing on whoever searches first.
    live();

    const send = async (request: (id: number) => QueryWorkerRequest): Promise<QueryWorkerResponse | undefined> => {
        if (closed) {
            return undefined;
        }
        const id = nextId++;
        const message = request(id);
        const answered = new Promise<QueryWorkerResponse | undefined>((resolve) => {
            pending.set(id, resolve);
        });
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads, not window: this postMessage takes no targetOrigin
        live().postMessage(message);
        const response = await answered;
        if (response?.type === "failed") {
            options.onError?.(new Error(`iq query worker: ${message.type} failed: ${response.error}`));
            return undefined;
        }
        return response;
    };

    return {
        metrics: () => ({ live: worker !== undefined, pendingRequests: pending.size }),
        async semantic(query, allowed) {
            const response = await send((id) => ({ type: "semantic", id, query, allowed: [...allowed] }));
            return response?.type === "semantic" ? { hits: response.hits, pending: response.pending } : undefined;
        },
        async rerank(query, passages) {
            const response = await send((id) => ({ type: "rerank", id, query, passages: [...passages] }));
            return response?.type === "rerank" ? response.scores : undefined;
        },
        async close() {
            closed = true;
            const running = worker;
            worker = undefined;
            // Whatever was mid-flight is settled here rather than left to the exit handler this close is about
            // to bypass: a shutdown that leaves a query's promise dangling is the same silent hang as a dead
            // worker, and a host draining its last requests would wait on it forever.
            settleAll();
            await running?.terminate();
        },
    };
};
