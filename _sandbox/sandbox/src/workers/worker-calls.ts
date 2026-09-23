import { extname } from "node:path";
import { type MessagePort, Worker } from "node:worker_threads";

// A call-and-answer channel to one worker thread, for work that must not run on the daemon's own loop. The worker is
// spawned on first call and again after a crash, is referenced only while a call is in flight so an idle one never
// keeps a process alive, and pairs every answer with its call by id.

// The worker module beside the caller, in whichever form is running: `.ts` under the test runner, `.js` from dist.
export const siblingModule = (meta: ImportMeta, name: string): URL => new URL(`./${name}${extname(meta.filename)}`, meta.url);

// What a worker posts: the answer to call `id`, or unprompted news (no `id`) that the caller reads through `onNews`.
// An answer may carry news too, so a caller's picture moves in the same message as the result it waited for.
export type WorkerAnswer<News> =
    | { readonly id: number; readonly ok: true; readonly value?: unknown; readonly news?: News }
    | { readonly id: number; readonly ok: false; readonly message: string }
    | { readonly id?: undefined; readonly news: News };

export interface WorkerCalls<Ask> {
    readonly call: <T>(ask: Ask) => Promise<T>;
    readonly close: () => Promise<void>;
}

// Posts with worker_threads' own second parameter, an empty transfer list: a thread has no target origin to name.
export const post = (port: MessagePort | Worker, message: unknown): void => port.postMessage(message, []);

export const workerCalls = <Ask extends object, News = never>(url: URL, workerData: unknown, onNews?: (news: News) => void): WorkerCalls<Ask> => {
    const pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>();
    let nextId = 0;
    let worker: Worker | undefined;

    const spawn = (): Worker => {
        const spawned = new Worker(url, { workerData });
        // A crash costs the calls in flight and no later one: the next call spawns a fresh worker.
        const fail = (error: Error): void => {
            if (worker === spawned) {
                worker = undefined;
            }
            for (const waiter of pending.values()) {
                waiter.reject(error);
            }
            pending.clear();
        };
        spawned.on("message", (answer: WorkerAnswer<News>) => {
            if ("news" in answer && answer.news !== undefined) {
                onNews?.(answer.news);
            }
            const waiter = answer.id === undefined ? undefined : pending.get(answer.id);
            if (answer.id === undefined || waiter === undefined) {
                return;
            }
            pending.delete(answer.id);
            if (pending.size === 0) {
                spawned.unref();
            }
            if (answer.ok) {
                waiter.resolve(answer.value);
                return;
            }
            waiter.reject(new Error(answer.message));
        });
        spawned.on("error", fail);
        spawned.on("exit", (code) => fail(new Error(`a worker thread exited with code ${String(code)}`)));
        spawned.unref();
        return spawned;
    };

    return {
        call: <T>(ask: Ask): Promise<T> =>
            new Promise<T>((resolve, reject) => {
                worker ??= spawn();
                nextId += 1;
                pending.set(nextId, { resolve: resolve as (value: unknown) => void, reject });
                worker.ref();
                post(worker, { ...ask, id: nextId });
            }),
        close: async () => {
            await worker?.terminate();
        },
    };
};

// The worker side for a thread that answers calls as they arrive, one after another.
export const serveCalls = <Ask extends { readonly id: number }>(port: MessagePort, answer: (ask: Ask) => Promise<unknown>): void => {
    port.on("message", (ask: Ask) => {
        void answer(ask).then(
            (value) => post(port, { id: ask.id, ok: true, value } satisfies WorkerAnswer<never>),
            (error: unknown) => post(port, { id: ask.id, ok: false, message: error instanceof Error ? error.message : String(error) } satisfies WorkerAnswer<never>),
        );
    });
};
