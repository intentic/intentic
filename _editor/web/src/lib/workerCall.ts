// A call a dedicated worker answers, or this thread when it cannot: no worker here, crashed, unclonable payload, or a throw.

/* oxlint-disable unicorn/require-post-message-target-origin -- dedicated-worker postMessage has no target origin */

export interface WorkerCallRequest<Args> {
    readonly id: number;
    readonly args: Args;
}

export type WorkerCallResponse<Result> = { readonly id: number; readonly result: Result } | { readonly id: number; readonly error: string };

export interface WorkerPort<Args, Result> {
    postMessage(message: WorkerCallRequest<Args>): void;
    addEventListener(type: `message`, listener: (event: MessageEvent<WorkerCallResponse<Result>>) => void): void;
    addEventListener(type: `error`, listener: (event: ErrorEvent) => void): void;
    terminate(): void;
}

export type WorkerFactory<Args, Result> = () => Promise<WorkerPort<Args, Result> | undefined>;

/** The client side: calls queue on one lazily built worker, and a crashed worker is rebuilt by the next call. */
export const createWorkerCall = <Args, Result>(workerFactory: WorkerFactory<Args, Result>, local: (args: Args) => Result | Promise<Result>) => {
    const pending = new Map<number, { resolve: (result: Result) => void; reject: (error: Error) => void }>();
    let worker: Promise<WorkerPort<Args, Result> | undefined> | undefined;
    let requestId = 0;

    const connect = (): Promise<WorkerPort<Args, Result> | undefined> => {
        if (worker !== undefined) {
            return worker;
        }
        worker = workerFactory().then((port) => {
            port?.addEventListener(`message`, (event) => {
                const waiting = pending.get(event.data.id);
                if (waiting === undefined) {
                    return;
                }
                pending.delete(event.data.id);
                if (`error` in event.data) {
                    waiting.reject(new Error(event.data.error));
                    return;
                }
                waiting.resolve(event.data.result);
            });
            port?.addEventListener(`error`, (event) => {
                const error = event.error instanceof Error ? event.error : new Error(event.message || `Worker failed.`);
                for (const waiting of pending.values()) {
                    waiting.reject(error);
                }
                pending.clear();
                port.terminate();
                worker = undefined;
            });
            return port;
        });
        void worker.catch(() => (worker = undefined));
        return worker;
    };

    return async (args: Args): Promise<Result> => {
        const port = await connect().catch(() => undefined);
        if (port === undefined) {
            return local(args);
        }
        const id = ++requestId;
        return new Promise<Result>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            try {
                port.postMessage({ id, args });
            } catch (error) {
                pending.delete(id);
                throw error;
            }
        }).catch(() => local(args));
    };
};

/** The worker side: answers every call with `run`'s result, or with its error so the caller can fall back. */
export const serveWorkerCall = <Args, Result>(run: (args: Args) => Result | Promise<Result>): void => {
    self.addEventListener(`message`, (event: MessageEvent<WorkerCallRequest<Args>>) => {
        const { id, args } = event.data;
        void (async () => {
            try {
                self.postMessage({ id, result: await run(args) } satisfies WorkerCallResponse<Result>);
            } catch (error) {
                self.postMessage({ id, error: error instanceof Error ? error.message : `Worker call failed.` } satisfies WorkerCallResponse<Result>);
            }
        })();
    });
};
