import { type ChildProcess, fork } from "node:child_process";
import type { CodebaseHealth, HealthRequest } from "../engines/health.js";
import type { ResidentEngine, ResidentEngineMetrics, ResidentEngineOptions } from "../index.js";
import type { IndexStatus, QueryOutcome, QueryRequest } from "../types.js";
import type { EngineAnswer, EngineEvent, EngineMetricsSnapshot, EngineRequest } from "./protocol.js";

// A ResidentEngine by interface, a proxy by implementation: the index and ML models live in a separate process, so
// their memory does not sit in the daemon's own heap. Costs one IPC round trip and a structured clone per query. A dead
// child is recoverable: the next call starts a fresh one, which re-sweeps and re-claims the index.

// Always the built JS in dist/, since a forked child has no TypeScript loader.
const childModule = new URL("../../dist/host/child.js", import.meta.url);

interface Pending {
    readonly resolve: (value: EngineAnswer) => void;
    readonly reject: (error: Error) => void;
    // Torn down when the call settles, so a long-lived signal doesn't accumulate one listener per search.
    readonly forget: () => void;
}

// Before the child pushes anything: the true state, shaped like an in-process engine's at the same instant.
const COLD: EngineMetricsSnapshot = {
    files: 0,
    generation: 0,
    dirtySequence: 0,
    appliedSequence: 0,
    revalidated: false,
    sweptAt: undefined,
    embedBacklog: 0,
    queryWorker: { live: false, pendingRequests: 0 },
};

const rebuild = (message: string, stack?: string): Error => {
    const error = new Error(message);
    if (stack !== undefined) {
        error.stack = stack;
    }
    return error;
};

// A ResidentEngine plus pid(): which process is holding the memory, since `ps` cannot tell node's children apart.
// undefined between a child dying and the next call starting one.
export interface EngineClient extends ResidentEngine {
    pid(): number | undefined;
}

export const createEngineClient = (options: ResidentEngineOptions): EngineClient => {
    const { onIndexError, onQueryError, onIndexProgress, ...init } = options;
    const pending = new Map<number, Pending>();
    let child: ChildProcess | undefined;
    let nextId = 0;
    let metrics = COLD;
    let closed = false;

    const fail = (error: Error): void => {
        const orphaned = [...pending.values()];
        pending.clear();
        for (const waiting of orphaned) {
            waiting.forget();
            waiting.reject(error);
        }
    };

    const receive = (event: EngineEvent): void => {
        if (event.type === "metrics") {
            metrics = event.metrics;
            return;
        }
        if (event.type === "indexProgress") {
            onIndexProgress?.(event.remaining);
            return;
        }
        if (event.type === "indexError") {
            onIndexError?.(rebuild(event.message, event.stack));
            return;
        }
        if (event.type === "queryError") {
            onQueryError?.(rebuild(event.message, event.stack));
            return;
        }
        const waiting = pending.get(event.id);
        if (waiting === undefined) {
            return;
        }
        pending.delete(event.id);
        waiting.forget();
        if (event.type === "failed") {
            waiting.reject(rebuild(event.message, event.stack));
            return;
        }
        waiting.resolve(event.value);
    };

    const start = (): ChildProcess | undefined => {
        if (child !== undefined || closed) {
            return child;
        }
        // advanced serialization, not JSON: QueryRequest.features is a Set, and optionals need absent-vs-undefined
        // kept.
        const started = fork(childModule, { serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] });
        started.on("message", (message) => receive(message as EngineEvent));
        // A dead child takes its in-flight calls with it, reported through onQueryError (the host's channel for a
        // degraded search). The handle is dropped so the next call starts a fresh child, index claim and all.
        started.on("exit", (code, signal) => {
            child = undefined;
            metrics = COLD;
            if (closed) {
                return;
            }
            const how = signal ?? `code ${String(code)}`;
            onQueryError?.(new Error(`iq engine process exited (${how}): a new one starts on the next search`));
            fail(new Error(`iq engine process exited (${how})`));
        });
        // A fork that can't start reports here instead of as an unhandled 'error' event, which would take the daemon
        // down. The `exit` handler above drops the handle so the next call retries.
        started.on("error", (error) => {
            onQueryError?.(error);
        });
        child = started;
        // Sent before this function returns, so nothing can reach the child ahead of it; IPC preserves order.
        started.send({ type: "init", options: init } satisfies EngineRequest);
        return started;
    };

    const call = (build: (id: number) => EngineRequest, signal?: AbortSignal): Promise<EngineAnswer> => {
        const channel = start();
        if (channel === undefined) {
            return Promise.reject(new Error("iq engine is closed"));
        }
        const id = nextId;
        nextId += 1;
        return new Promise<EngineAnswer>((resolve, reject) => {
            const abort = (): void => {
                channel.send({ type: "abort", id } satisfies EngineRequest, () => undefined);
            };
            signal?.addEventListener("abort", abort, { once: true });
            pending.set(id, { resolve, reject, forget: () => signal?.removeEventListener("abort", abort) });
            channel.send(build(id), (error) => {
                // Channel closed between the check above and the write; the exit handler may have already rejected this
                // id.
                if (error !== null) {
                    pending.delete(id);
                    signal?.removeEventListener("abort", abort);
                    reject(error);
                }
            });
            // An already-aborted signal never fires its event; forwarded here once the request is on the wire.
            if (signal?.aborted === true) {
                abort();
            }
        });
    };

    // Started eagerly: an in-process engine begins indexing in its constructor, and boot relies on that.
    start();

    return {
        pid: () => child?.pid,
        // Synchronous, from the last pushed snapshot; age is computed here so an idle sweep keeps getting older.
        metrics: (): ResidentEngineMetrics => ({
            files: metrics.files,
            generation: metrics.generation,
            dirtySequence: metrics.dirtySequence,
            appliedSequence: metrics.appliedSequence,
            revalidated: metrics.revalidated,
            sweepAgeMs: metrics.sweptAt === undefined ? undefined : Date.now() - metrics.sweptAt,
            embedBacklog: metrics.embedBacklog,
            queryWorker: metrics.queryWorker,
        }),
        run: (request: QueryRequest, signal?: AbortSignal) => call((id) => ({ type: "run", id, request }), signal) as Promise<QueryOutcome>,
        health: (request: HealthRequest) => call((id) => ({ type: "health", id, request })) as Promise<CodebaseHealth>,
        invalidateHealth: () => {
            start()?.send({ type: "healthDirty" } satisfies EngineRequest, () => undefined);
        },
        warm: () => call((id) => ({ type: "warm", id })) as Promise<IndexStatus>,
        // Fire-and-forget; one that arrives while the child restarts is covered by the fresh child's own first pass.
        markDirty: () => {
            start()?.send({ type: "dirty" } satisfies EngineRequest, () => undefined);
        },
        async close() {
            if (closed) {
                return;
            }
            if (child === undefined) {
                closed = true;
                return;
            }
            // Issued before `closed` is set, or this call would refuse itself; the flag goes up right after, so the
            // exit this causes is not reported as a crash. Failure here is not worth propagating: shutdown continues
            // regardless.
            const finished = call((id) => ({ type: "close", id })).catch(() => undefined);
            closed = true;
            await finished;
            fail(new Error("iq engine is closed"));
        },
    };
};
