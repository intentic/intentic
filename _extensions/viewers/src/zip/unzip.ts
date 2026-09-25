import { createWorkerCall, type WorkerFactory } from "@intentic/extension-ui/worker";
import { type Unzipped, unzipSync } from "fflate";

// An archive's parts, inflated off the page: a 25 MiB document is seconds of inflate, which on the page is seconds of a
// frozen editor. Where no worker can run, or one dies, the page does it itself. A file the worker could not read is
// refused as such, not retried here: the page would only refuse it again.
export const createUnzip = (workerFactory: WorkerFactory<Uint8Array, Unzipped>): ((bytes: Uint8Array) => Promise<Unzipped>) =>
    createWorkerCall(workerFactory, (bytes) => unzipSync(bytes), { final: () => true });

export const unzipParts = createUnzip(async () => {
    if (typeof Worker === `undefined`) {
        return undefined;
    }
    const { default: UnzipWorker } = await import(`./unzipWorker?worker`);
    return new UnzipWorker();
});
