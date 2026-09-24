import { createWorkerCall } from "../../../../lib/workerCall";
import { compareSides, type SidesComparison } from "./imageSides";

export interface ImageSidesArgs {
    readonly before: Blob;
    readonly after: Blob;
}

// Decoding both sides and reading every pixel back holds a thread for hundreds of milliseconds at 4K; a worker holds
// its own. Blobs cross by reference, so the call costs no copy of either image.
export const compareImageSides = createWorkerCall<ImageSidesArgs, SidesComparison | undefined>(
    async () => {
        if (typeof Worker === `undefined`) {
            return undefined;
        }
        const { default: ImageSidesWorker } = await import(`./imageSidesWorker?worker`);
        return new ImageSidesWorker();
    },
    ({ before, after }) => compareSides(before, after),
);
