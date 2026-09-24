import { unzipSync } from "fflate";
import type { UnzipRequest, UnzipResponse } from "./unzip";

/* oxlint-disable unicorn/require-post-message-target-origin -- dedicated-worker postMessage has no target origin */

// Each part comes back transferred, not copied; a buffer two parts share is listed once, since transferring it twice throws.
self.addEventListener(`message`, (event: MessageEvent<UnzipRequest>) => {
    const { id, bytes } = event.data;
    try {
        const parts = unzipSync(bytes);
        const buffers = new Set(Object.values(parts).map((part) => part.buffer as ArrayBuffer));
        self.postMessage({ id, parts } satisfies UnzipResponse, { transfer: [...buffers] });
    } catch (error) {
        self.postMessage({ id, error: error instanceof Error ? error.message : `Could not unzip this file.` } satisfies UnzipResponse);
    }
});
