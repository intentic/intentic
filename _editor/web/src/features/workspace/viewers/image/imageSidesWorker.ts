import { serveWorkerCall } from "../../../../lib/workerCall";
import { compareSides } from "./imageSides";
import type { ImageSidesArgs } from "./imageSidesClient";

// Without OffscreenCanvas a worker has no surface to decode onto; the throw sends the call back to the page, which has.
serveWorkerCall(({ before, after }: ImageSidesArgs) => {
    if (typeof OffscreenCanvas !== `function`) {
        throw new Error(`No OffscreenCanvas in this worker.`);
    }
    return compareSides(before, after);
});
