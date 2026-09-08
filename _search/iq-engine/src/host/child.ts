import { createResidentEngine, type ResidentEngine } from "../index.js";
import type { EngineAnswer, EngineEvent, EngineMetricsSnapshot, EngineRequest } from "./protocol.js";

// The engine's own process: the SQLite index, the two ML models, the indexer worker and the cached sweep all live here;
// the daemon keeps none of it. Opposite of git-forker.ts, which stays import-free to fork cheaply.

const send = process.send?.bind(process);
if (send === undefined) {
    throw new Error("iq engine child started without an IPC channel");
}
// Guarded on process.connected: a metrics tick or backlog event firing after the parent is gone would otherwise crash
// the child with ERR_IPC_CHANNEL_CLOSED.
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
// Init failure kept so later requests answer with the real reason instead of "engine not initialised".
let broken: unknown;

// One AbortController per in-flight query, dropped when it settles; how abort crosses the process boundary.
const running = new Map<number, AbortController>();

const answer = async (id: number, work: () => Promise<EngineAnswer>): Promise<void> => {
    try {
        emit({ type: "settled", id, value: await work() });
    } catch (error) {
        emit({ type: "failed", id, ...describe(error) });
    }
};

// Pushed only on change (compared field by field); an idle engine's identical snapshot sends nothing.
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

// unref'd: this timer must never be the reason the child outlives its work; the channel holds it open.
const ticker = setInterval(publishMetrics, METRICS_INTERVAL_MS);
ticker.unref();

process.on("message", (message: EngineRequest) => {
    if (message.type === "init") {
        try {
            engine = createResidentEngine({
                ...message.options,
                onIndexError: (error) => emit({ type: "indexError", ...describe(error) }),
                onQueryError: (error) => emit({ type: "queryError", ...describe(error) }),
                // Fires on every backlog slice, so metrics ride the same beat as progress instead of waiting for the
                // timer.
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
        if (message.type !== "dirty" && message.type !== "healthDirty") {
            emit({ type: "failed", id: message.id, ...describe(broken ?? new Error("iq engine child received a request before init")) });
        }
        return;
    }
    const live = engine;
    if (message.type === "dirty") {
        live.markDirty();
        return;
    }
    if (message.type === "healthDirty") {
        live.invalidateHealth();
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
    // close: the answer goes out before the channel does, since disconnecting first strands the parent waiting on an
    // unsendable reply. engine.close() releases both workers and the index claim before the process exits.
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

// Daemon gone means nothing to serve; close first, since the index claim is a pid file a later process would otherwise
// find held by a dead owner.
process.on("disconnect", () => {
    void (async () => {
        await engine?.close().catch(() => undefined);
        process.exit(0);
    })();
});
