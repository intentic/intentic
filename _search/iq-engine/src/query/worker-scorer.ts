import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { packageRoot } from "@intentic/constants/node";
import type { QueryWorkerData, QueryWorkerRequest, QueryWorkerResponse } from "./query-worker.js";
import type { QueryScorer } from "./scorer.js";

// Points at built dist output: a worker thread has no TypeScript loader.
const WORKER_URL = pathToFileURL(join(packageRoot(import.meta.url), "dist/query/query-worker.js"));

export interface WorkerScorerOptions {
    readonly indexDir: string;
    readonly modelDir: string | undefined;
    // Fires when the worker thread dies (OOM, a broken model); queries in flight degrade and the next respawns it.
    readonly onError?: (error: Error) => void;
}

export interface WorkerScorer extends QueryScorer {
    metrics(): { readonly live: boolean; readonly pendingRequests: number };
    close(): Promise<void>;
}

// Daemon-side counterpart to query-worker.ts: spawns it, correlates answers to requests, and outlives its death. A dead
// worker degrades to BM25 like a host with no model dir; the next query gets a fresh thread.
export const workerScorer = (options: WorkerScorerOptions): WorkerScorer => {
    const pending = new Map<number, (response: QueryWorkerResponse | undefined) => void>();
    let worker: Worker | undefined;
    let nextId = 0;
    let closed = false;

    // Settles every request in flight with undefined so callers degrade instead of hanging.
    const settleAll = (): void => {
        const waiting = [...pending.values()];
        pending.clear();
        for (const settle of waiting) {
            settle(undefined);
        }
    };

    // Drops the worker reference along with pending requests so the next call spawns a fresh thread.
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
        // Not unref'd: a pending request must keep the process alive until it is answered.
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
            // Only reached for an unrequested exit; close() clears `worker` before terminating.
            if (worker === spawned) {
                abandon(spawned, new Error("iq query worker exited"));
            }
        });
        worker = spawned;
        return spawned;
    };

    // Spawned eagerly, not on first query, so model loading overlaps the host's boot instead of the first search.
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
            // Settled here rather than left to the exit handler close() bypasses, so nothing waits on it forever.
            settleAll();
            await running?.terminate();
        },
    };
};
