import { type Unzipped, unzipSync } from "fflate";

// An archive's parts, inflated off the page: a 25 MiB document is seconds of inflate, which on the page is seconds of a
// frozen editor. Where no worker can run, or one dies, the page does it itself.

/* oxlint-disable unicorn/require-post-message-target-origin -- dedicated-worker postMessage has no target origin */

export interface UnzipRequest {
    readonly id: number;
    readonly bytes: Uint8Array;
}

export type UnzipResponse = { readonly id: number; readonly parts: Unzipped } | { readonly id: number; readonly error: string };

export interface UnzipPort {
    postMessage(message: UnzipRequest): void;
    addEventListener(type: `message`, listener: (event: MessageEvent<UnzipResponse>) => void): void;
    addEventListener(type: `error`, listener: (event: ErrorEvent) => void): void;
    terminate(): void;
}

// Answers undefined where no worker can be built, which leaves the unzip to the page.
export type UnzipPortFactory = () => Promise<UnzipPort | undefined>;

// A file the worker could not read is refused as such, not retried here: the page would only refuse it again.
class Unreadable extends Error {}

/** Calls queue on one lazily built worker; a crashed one is rebuilt by the next call, and its calls finish on the page. */
export const createUnzip = (portFactory: UnzipPortFactory): ((bytes: Uint8Array) => Promise<Unzipped>) => {
    const pending = new Map<number, { readonly resolve: (parts: Unzipped) => void; readonly reject: (error: Error) => void }>();
    let port: Promise<UnzipPort | undefined> | undefined;
    let requestId = 0;
    const connect = (): Promise<UnzipPort | undefined> => {
        port ??= portFactory().then((worker) => {
            worker?.addEventListener(`message`, (event) => {
                const waiting = pending.get(event.data.id);
                pending.delete(event.data.id);
                if (waiting !== undefined) {
                    if (`error` in event.data) {
                        waiting.reject(new Unreadable(event.data.error));
                    } else {
                        waiting.resolve(event.data.parts);
                    }
                }
            });
            worker?.addEventListener(`error`, (event) => {
                for (const waiting of pending.values()) {
                    waiting.reject(new Error(event.message || `Unzip worker failed.`));
                }
                pending.clear();
                worker.terminate();
                port = undefined;
            });
            return worker;
        });
        void port.catch(() => (port = undefined));
        return port;
    };
    return async (bytes) => {
        const worker = await connect().catch(() => undefined);
        if (worker === undefined) {
            return unzipSync(bytes);
        }
        const id = ++requestId;
        try {
            return await new Promise<Unzipped>((resolve, reject) => {
                pending.set(id, { resolve, reject });
                worker.postMessage({ id, bytes });
            });
        } catch (error) {
            if (error instanceof Unreadable) {
                throw error;
            }
            pending.delete(id);
            return unzipSync(bytes);
        }
    };
};

export const unzipParts = createUnzip(async () => {
    if (typeof Worker === `undefined`) {
        return undefined;
    }
    const { default: UnzipWorker } = await import(`./unzipWorker?worker`);
    return new UnzipWorker();
});
