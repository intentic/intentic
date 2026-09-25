import { serveWorkerCall } from "@intentic/extension-ui/worker";
import { unzipSync } from "fflate";

// Each part comes back transferred, not copied; a buffer two parts share is listed once, since transferring it twice throws.
serveWorkerCall((bytes: Uint8Array) => unzipSync(bytes), {
    transfer: (parts) => [...new Set(Object.values(parts).map((part) => part.buffer as ArrayBuffer))],
});
