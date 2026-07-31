import { parentPort, workerData } from "node:worker_threads";
import type { Logger } from "pino";
import { createWorkspaceWatch } from "./workspace-watch.js";

/* The recursive chokidar owner. This file is a separate compiled entry because its whole purpose is to keep
 * thousands of libuv filesystem handles and their burst processing off the daemon's control-plane isolate. */
const port = parentPort;
if (port === null) {
    throw new Error("workspace watch worker requires a parent port");
}
const { root } = workerData as { root: string };
const logger = {
    warn: (value: { err: unknown }) => {
        const error = value.err;
        port.postMessage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    },
} as unknown as Logger;
const watcher = createWorkspaceWatch(root, logger);
watcher.subscribe((paths) => port.postMessage({ kind: "paths", paths }));

port.on("close", () => void watcher.close());
