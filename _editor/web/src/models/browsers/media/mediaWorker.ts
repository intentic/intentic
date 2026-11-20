import type { FromWorker, ToWorker } from "./worker/workerWire";

// The page's handle on its decode worker (worker/decodeWorker.ts), and the one seam a test replaces: every message to the
// worker goes through `post`, every message from it arrives at `listen`'s handler.

export interface MediaWorker {
    readonly post: (message: ToWorker, transfer?: Transferable[]) => void;
    readonly listen: (handler: (message: FromWorker) => void) => void;
    readonly terminate: () => void;
}

/** Starts a decode worker; undefined where the browser cannot run one with a canvas of its own. */
export const startMediaWorker = (): MediaWorker | undefined => {
    if (!(`OffscreenCanvas` in globalThis) || !(`VideoDecoder` in globalThis)) {
        return undefined;
    }
    const worker = new Worker(new URL(`./worker/decodeWorker.ts`, import.meta.url), { type: `module`, name: `media-decode` });
    return {
        post: (message, transfer = []) => worker.postMessage(message, transfer),
        listen: (handler) => worker.addEventListener(`message`, (event: MessageEvent<FromWorker>) => handler(event.data)),
        terminate: () => worker.terminate(),
    };
};
