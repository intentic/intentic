import { createResidentEngine, type ResidentEngine } from "../index.js";
import type { EngineAnswer, EngineEvent, EngineMetricsSnapshot, EngineRequest } from "./protocol.js";

/* THE ENGINE'S OWN PROCESS. Everything a search needs — the SQLite index, the two ML models on the query
 * worker, the indexer worker, the cached workspace sweep — is resident HERE, and the daemon that asks the
 * questions keeps none of it. client.ts holds the argument for why that is worth a process.
 *
 * The opposite of git-forker.ts, which must stay import-free to fork cheaply: this child is where the weight is
 * SUPPOSED to be. It forks nothing and serves one thing, so its resident size costs nobody anything. */

const send = process.send?.bind(process);
if (send === undefined) {
    throw new Error("iq engine child started without an IPC channel");
}
// Guarded on the channel, because plenty of things here fire on their own schedule — a metrics tick, an index
// pass that fails, the last slice of an embedding backlog — and any one of them landing after the parent has
// gone would otherwise take the child down with an unhandled ERR_IPC_CHANNEL_CLOSED instead of ending it.
const emit = (event: EngineEvent): void => {
    if (process.connected) {
        send(event, () => undefined);
    }
};

const describe = (error: unknown): { message: string; stack?: string } => {
    const failure = error instanceof Error ? error : new Error(String(error));
    return { message: failure.message, ...(failure.stack !== undefined ? { stack: failure.stack } : {}) };
};

let engine: ResidentEngine | undefined;
// A constructor that threw (an index dir that cannot be opened at all) leaves nothing to serve. Kept rather
// than thrown away so every later request answers with the REAL reason instead of "engine not initialised",
// which would send the host looking in the wrong place.
let broken: unknown;

// Aborting reaches across the boundary through this: one controller per in-flight query, dropped when the query
// settles. Runs that arrive with no signal on the parent side simply never appear here.
const running = new Map<number, AbortController>();

const answer = async (id: number, work: () => Promise<EngineAnswer>): Promise<void> => {
    try {
        emit({ type: "settled", id, value: await work() });
    } catch (error) {
        emit({ type: "failed", id, ...describe(error) });
    }
};

/* PUSHED ON CHANGE, not on a schedule, because the host reads this synchronously and the channel should be
 * silent while nothing moves. Compared against the last push field by field — `sweptAt` is a timestamp exactly
 * so that an idle engine produces an IDENTICAL snapshot and sends nothing at all. */
let published: EngineMetricsSnapshot | undefined;
const METRICS_INTERVAL_MS = 2000;

const snapshot = (): EngineMetricsSnapshot | undefined => {
    if (engine === undefined) {
        return undefined;
    }
    const { sweepAgeMs, ...rest } = engine.metrics();
    return { ...rest, sweptAt: sweepAgeMs === undefined ? undefined : Date.now() - sweepAgeMs };
};

const same = (a: EngineMetricsSnapshot, b: EngineMetricsSnapshot): boolean =>
    a.files === b.files &&
    a.generation === b.generation &&
    a.dirtySequence === b.dirtySequence &&
    a.appliedSequence === b.appliedSequence &&
    a.revalidated === b.revalidated &&
    a.sweptAt === b.sweptAt &&
    a.embedBacklog === b.embedBacklog &&
    a.queryWorker.live === b.queryWorker.live &&
    a.queryWorker.pendingRequests === b.queryWorker.pendingRequests;

const publishMetrics = (): void => {
    const current = snapshot();
    if (current === undefined || (published !== undefined && same(published, current))) {
        return;
    }
    published = current;
    emit({ type: "metrics", metrics: current });
};

// unref'd: this timer must never be the reason the child outlives its work. The channel is what holds it open.
const ticker = setInterval(publishMetrics, METRICS_INTERVAL_MS);
ticker.unref();

process.on("message", (message: EngineRequest) => {
    if (message.type === "init") {
        try {
            engine = createResidentEngine({
                ...message.options,
                onIndexError: (error) => emit({ type: "indexError", ...describe(error) }),
                onQueryError: (error) => emit({ type: "queryError", ...describe(error) }),
                // Every slice of the embedding backlog, and the pass that publishes it is also the one that
                // moves the numbers the host plots — so the metrics ride the same beat instead of waiting out
                // the timer above.
                onIndexProgress: (remaining) => {
                    emit({ type: "indexProgress", remaining });
                    publishMetrics();
                },
            });
        } catch (error) {
            broken = error;
            emit({ type: "indexError", ...describe(error) });
        }
        return;
    }
    if (message.type === "abort") {
        running.get(message.id)?.abort();
        return;
    }
    if (engine === undefined) {
        if (message.type !== "dirty") {
            emit({ type: "failed", id: message.id, ...describe(broken ?? new Error("iq engine child received a request before init")) });
        }
        return;
    }
    const live = engine;
    if (message.type === "dirty") {
        live.markDirty();
        return;
    }
    if (message.type === "warm") {
        void answer(message.id, async () => {
            const status = await live.warm();
            publishMetrics();
            return status;
        });
        return;
    }
    if (message.type === "health") {
        void answer(message.id, () => live.health(message.request));
        return;
    }
    if (message.type === "run") {
        const controller = new AbortController();
        running.set(message.id, controller);
        void answer(message.id, async () => {
            try {
                return await live.run(message.request, controller.signal);
            } finally {
                running.delete(message.id);
                publishMetrics();
            }
        });
        return;
    }
    /* close: the answer goes out BEFORE the channel does — disconnecting first would leave the parent waiting
     * on a reply that can no longer be sent. Nothing is force-exited after that: engine.close() terminates both
     * workers and releases the index claim, the metrics timer is unref'd, and the disconnect handler below ends
     * the process once there is nothing left holding it. */
    const { id } = message;
    void (async () => {
        try {
            await live.close();
            emit({ type: "settled", id, value: undefined });
        } catch (error) {
            emit({ type: "failed", id, ...describe(error) });
        }
        engine = undefined;
        clearInterval(ticker);
        process.disconnect();
    })();
});

// The daemon going away leaves nothing to serve. Close first — the index claim is a pid file, and a child that
// exits without releasing it leaves the next process to discover the owner is dead rather than being told.
process.on("disconnect", () => {
    void (async () => {
        await engine?.close().catch(() => undefined);
        process.exit(0);
    })();
});
