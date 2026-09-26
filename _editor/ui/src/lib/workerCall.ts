// A call a dedicated worker answers, or this thread when it cannot: no worker here, crashed, unclonable payload, or a
// throw. The client half and the worker half of one protocol, so a feature that moves work off the page writes only
// the work. Where the work is sometimes cheap, check that first and run it inline, so the first frame can draw it:
//
//     export const diffTables = (args) => (worstCase(args) <= INLINE_LIMIT ? tableDiff(args) : requestTableDiff(args));
//
// (`tableDiffClient.ts` in the editor is the worked example.)

/* oxlint-disable unicorn/require-post-message-target-origin -- dedicated-worker postMessage has no target origin */

export interface WorkerCallRequest<Args> {
    readonly id: number;
    readonly args: Args;
}

export type WorkerCallResponse<Result> = { readonly id: number; readonly result: Result } | { readonly id: number; readonly error: string };

export interface WorkerPort<Args, Result> {
    postMessage(message: WorkerCallRequest<Args>, transfer?: Transferable[]): void;
    addEventListener(type: `message`, listener: (event: MessageEvent<WorkerCallResponse<Result>>) => void): void;
    addEventListener(type: `error`, listener: (event: ErrorEvent) => void): void;
    terminate(): void;
}

export type WorkerFactory<Args, Result> = () => Promise<WorkerPort<Args, Result> | undefined>;

/** What the worker's own function threw, as opposed to the worker dying or never starting. */
export class WorkerCallError extends Error {
    override readonly name = `WorkerCallError`;
}

// A call its caller closed: nobody wants its answer, from the worker or from the page.
class WorkerClosed extends Error {}

export interface WorkerCallOptions<Args> {
    /** Buffers handed over rather than copied. The page no longer holds them after, so a call that transfers has no
     * local fallback to run on its arguments: its failures reject. */
    readonly transfer?: (args: Args) => Transferable[];
    /** A failure the page would only repeat (a file the worker could not read): rejected as it came instead of running
     * `local`. Crashes still fall back. */
    readonly final?: (error: WorkerCallError) => boolean;
}

/** A call into the worker; `close` ends the worker and rejects what still waits, and the next call builds a new one. */
export type WorkerCall<Args, Result> = ((args: Args) => Promise<Result>) & { readonly close: () => void };

/** The client side: calls queue on one lazily built worker, and a crashed worker is rebuilt by the next call. */
export const createWorkerCall = <Args, Result>(
    workerFactory: WorkerFactory<Args, Result>,
    local: (args: Args) => Result | Promise<Result>,
    options: WorkerCallOptions<Args> = {},
): WorkerCall<Args, Result> => {
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
                    waiting.reject(new WorkerCallError(event.data.error));
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

    const close = (): void => {
        const closing = worker;
        worker = undefined;
        const error = new WorkerClosed(`Worker closed.`);
        for (const waiting of pending.values()) {
            waiting.reject(error);
        }
        pending.clear();
        // allow(silent-catch): a worker that never started has nothing to terminate.
        void closing?.then((port) => port?.terminate()).catch(() => undefined);
    };

    const call = async (args: Args): Promise<Result> => {
        // allow(silent-catch): a worker that cannot be built is the page's cue to run the call itself, right below.
        const port = await connect().catch(() => undefined);
        if (port === undefined) {
            return local(args);
        }
        const id = ++requestId;
        const transfer = options.transfer?.(args);
        try {
            return await new Promise<Result>((resolve, reject) => {
                pending.set(id, { resolve, reject });
                port.postMessage({ id, args }, transfer);
            });
        } catch (error) {
            pending.delete(id);
            if (transfer !== undefined || error instanceof WorkerClosed || (error instanceof WorkerCallError && options.final?.(error) === true)) {
                throw error;
            }
            return local(args);
        }
    };
    return Object.assign(call, { close });
};

export interface ServeOptions<Result> {
    /** Buffers in the answer handed back rather than copied; each listed once, since transferring one twice throws. */
    readonly transfer?: (result: Result) => Transferable[];
}

/** The worker side: answers every call with `run`'s result, or with its error so the caller can fall back. */
export const serveWorkerCall = <Args, Result>(run: (args: Args) => Result | Promise<Result>, options: ServeOptions<Result> = {}): void => {
    self.addEventListener(`message`, (event: MessageEvent<WorkerCallRequest<Args>>) => {
        const { id, args } = event.data;
        void (async () => {
            try {
                const result = await run(args);
                self.postMessage({ id, result } satisfies WorkerCallResponse<Result>, { transfer: options.transfer?.(result) ?? [] });
            } catch (error) {
                self.postMessage({ id, error: error instanceof Error ? error.message : `Worker call failed.` } satisfies WorkerCallResponse<Result>);
            }
        })();
    });
};
