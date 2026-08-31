import { type ChildProcess, fork } from "node:child_process";
import type { CodebaseHealth, HealthRequest } from "../engines/health.js";
import type { ResidentEngine, ResidentEngineMetrics, ResidentEngineOptions } from "../index.js";
import type { IndexStatus, QueryOutcome, QueryRequest } from "../types.js";
import type { EngineAnswer, EngineEvent, EngineMetricsSnapshot, EngineRequest } from "./protocol.js";

/* THE ENGINE, ONE PROCESS OVER, a ResidentEngine by interface, a proxy by implementation.
 *
 * WHY. A resident engine is heavy by design and it is heavy in the WRONG PROCESS. Measured in the sandbox
 * daemon: ~2 GB RSS with only ~360 MB of V8 heap, the rest being this engine's two worker threads and their ML
 * models sharing the daemon's address space. On a memory-pressured host that means most of a gigabyte of the
 * DAEMON swapped out, and the daemon is the control plane, the thing every browser request, every agent turn
 * and every git poll goes through. Its symptoms were never search: 20–40 ms of baseline event-loop delay,
 * multi-second stalls with no I/O to blame, GC bursts of seconds per minute. A floor under everything.
 *
 * It is the same move exec.ts made for git and for the same reason, the daemon's own resident size is what
 * makes everything else expensive, except there the goal was cheap fork() and here it is a small hot set.
 *
 * WHAT THIS COSTS. One IPC round trip per query, and a structured clone of the result. Against a search that
 * does BM25, a semantic scan and a cross-encoder pass, that is noise; against the alternative, the daemon
 * paging in to answer a keystroke, it is not close.
 *
 * A CHILD THAT DIES is survivable, not fatal: the calls it was holding fail, the host hears about it through
 * onQueryError, and the next call starts a fresh one, which re-sweeps and re-claims the index, because that
 * is what a new engine does. */

/* The child's entry is BUILT javascript in every form this module runs in, from `dist/host/client.js` the
 * "../../dist" hop is the identity, and from `src/host/client.ts` (this package's own tests) it steps across
 * into the sibling build output, because a forked child has no TypeScript loader. Exactly what index.ts's
 * WORKER_URL does one level up, and why this package's `test` script builds first: the child a test drives has
 * to be this working tree's, not whatever was last compiled. */
const childModule = new URL("../../dist/host/child.js", import.meta.url);

interface Pending {
    readonly resolve: (value: EngineAnswer) => void;
    readonly reject: (error: Error) => void;
    // Torn down when the call settles, so a long-lived request signal (a browser tab's) does not accumulate one
    // listener per search it ever made.
    readonly forget: () => void;
}

// Before the child has pushed anything: an engine that has swept nothing and revalidated nothing, which is the
// truth at that moment rather than a placeholder. Identical in shape to what an in-process engine reports at
// the same instant, so the host's resource series has no special case for the boundary.
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

/* A ResidentEngine plus the one thing a host wants that an in-process engine has no answer for: WHICH process
 * is now holding the memory. The daemon logs it at boot, and it is what makes "the box is at 2 GB" a question
 * anyone can answer from the outside, `ps` sees several node children here and cannot say which is the engine.
 * `undefined` between a child dying and the next call bringing one up. */
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
        /* `advanced` serialization: the surface carries a Set (QueryRequest.features) and a great many
         * absent-vs-undefined optionals, both of which JSON IPC would quietly flatten. stdio is inherited so
         * that whatever the model loader prints lands in the daemon's own output rather than nowhere. */
        const started = fork(childModule, { serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] });
        started.on("message", (message) => receive(message as EngineEvent));
        // A dead child takes its in-flight calls with it. Reported through onQueryError because that is the
        // host's existing channel for "search is degraded and you should be able to see it"; the handle is
        // dropped so the next call starts a fresh child, index claim and all.
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
        // A fork that cannot even start (or a channel that cannot be written) reports here rather than as an
        // unhandled 'error' event, which would take the daemon down over a search. The `exit` above does the
        // rest: the handle is dropped and the next call tries again.
        started.on("error", (error) => {
            onQueryError?.(error);
        });
        child = started;
        // Sent before this function returns, so nothing can reach the child ahead of it. IPC preserves order.
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
                // The channel closed between the check above and the write; the exit handler may already have
                // rejected this id, in which case both of these are no-ops.
                if (error !== null) {
                    pending.delete(id);
                    signal?.removeEventListener("abort", abort);
                    reject(error);
                }
            });
            // A signal that was ALREADY aborted never fires its event, forward it once the request is on the
            // wire so the child does not start work the caller has given up on.
            if (signal?.aborted === true) {
                abort();
            }
        });
    };

    // Started eagerly, because an in-process engine begins its first index pass in its constructor and the boot
    // sequence relies on that: main.ts calls warm() and lets it run while the daemon serves.
    start();

    return {
        pid: () => child?.pid,
        // Synchronous, from the last snapshot the child pushed. The AGE is computed here rather than there so
        // an idle engine reports a sweep that keeps getting older instead of one frozen at the last push.
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
        // Fire-and-forget, exactly as in process: a change notification nobody waits on, and one that arrives
        // while the child is restarting is covered by the fresh child's own first pass.
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
            /* The child closes the engine (releasing the index claim) and then disconnects, which is what ends
             * it. Issued BEFORE the flag goes up, `closed` is what refuses new work, and setting it first
             * would refuse this call too, and the flag then goes up synchronously, so the exit it causes is
             * not reported to the host as a crash. Failure is not worth propagating: shutdown continues either
             * way, and the pid file a killed child leaves behind resolves to nothing on the next open. */
            const finished = call((id) => ({ type: "close", id })).catch(() => undefined);
            closed = true;
            await finished;
            fail(new Error("iq engine is closed"));
        },
    };
};
