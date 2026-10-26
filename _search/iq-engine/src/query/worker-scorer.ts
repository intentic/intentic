import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { workerIdle, type WorkerIdleOptions } from "./worker-idle.js";
import { packageRoot } from "@intentic/constants/node";
import type { QueryWorkerData, QueryWorkerRequest, QueryWorkerResponse } from "./query-worker.js";
import type { QueryScorer } from "./scorer.js";

// Points at built dist output: a worker thread has no TypeScript loader.
const WORKER_URL = pathToFileURL(join(packageRoot(import.meta.url), "dist/query/query-worker.js"));

export interface QueryThread {
    postMessage(request: QueryWorkerRequest): void;
    on(event: "message", listener: (response: QueryWorkerResponse) => void): void;
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "exit", listener: () => void): void;
    terminate(): Promise<number>;
}

export interface WorkerScorerOptions extends WorkerIdleOptions {
    readonly indexDir: string;
    readonly modelDir: string | undefined;
    // Fires when the worker thread dies (OOM, a broken model); queries in flight degrade and the next respawns it.
    readonly onError?: (error: Error) => void;
    readonly spawn?: () => QueryThread;
}

export interface WorkerScorer extends QueryScorer {
    metrics(): { readonly live: boolean; readonly pendingRequests: number };
    close(): Promise<void>;
}

type Pending = Map<number, (response: QueryWorkerResponse | undefined) => void>;

// A dead or closed thread settles requests as absent, preserving the lexical fallback.
const settleAll = (pending: Pending): void => {
    const waiting = [...pending.values()];
    pending.clear();
    for (const settle of waiting) {settle(undefined);}
};

// Daemon-side counterpart to query-worker.ts: spawns it, correlates answers to requests, and outlives its death. A dead
// worker degrades to BM25 like a host with no model dir; the next query gets a fresh thread.
export const workerScorer = (options: WorkerScorerOptions): WorkerScorer => {
    const pending: Pending = new Map();
    let worker: QueryThread | undefined;
    let nextId = 0;
    let closed = false;
    const idle = workerIdle(options, async () => {
        const held = worker;
        worker = undefined;
        await held?.terminate();
    });

    // Drops the worker reference along with pending requests so the next call spawns a fresh thread.
    const abandon = (dead: QueryThread, error: Error): void => {
        if (worker !== dead) {return;}
        worker = undefined;
        idle.busy();
        settleAll(pending);
        options.onError?.(error);
    };

    const live = (): QueryThread => {
        if (worker !== undefined) {
            return worker;
        }
        // Not unref'd: a pending request must keep the process alive until it is answered.
        const spawned = options.spawn?.() ?? new Worker(WORKER_URL, {
            workerData: { indexDir: options.indexDir, modelDir: options.modelDir } satisfies QueryWorkerData,
        });
        spawned.on("message", (response: QueryWorkerResponse) => {
            if (worker !== spawned) {return;}
            const settle = pending.get(response.id);
            pending.delete(response.id);
            settle?.(response);
            if (pending.size === 0) {
                idle.quiet();
            }
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

    const send = async (request: (id: number) => QueryWorkerRequest): Promise<QueryWorkerResponse | undefined> => {
        if (closed) {
            return undefined;
        }
        const id = nextId++;
        idle.busy();
        const message = request(id);
        const answered = new Promise<QueryWorkerResponse | undefined>((resolve) => {
            pending.set(id, resolve);
        });
        try {
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messages have no targetOrigin.
            live().postMessage(message);
        } catch (error) {
            pending.delete(id);
            options.onError?.(error instanceof Error ? error : new Error(String(error)));
            if (worker !== undefined && pending.size === 0) {idle.quiet();}
            return undefined;
        }
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
            idle.busy();
            const running = worker;
            worker = undefined;
            // Settled here rather than left to the exit handler close() bypasses, so nothing waits on it forever.
            settleAll(pending);
            await running?.terminate();
        },
    };
};
