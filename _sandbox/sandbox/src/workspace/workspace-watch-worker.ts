import { parentPort, workerData } from "node:worker_threads";
import { errorMessage } from "@intentic/base/errors";
import type { Logger } from "pino";
import { createWorkspaceWatch } from "./workspace-watch.js";

/* The recursive watcher's owner. A separate compiled entry because it was the only way to keep thousands of
 * libuv filesystem handles off the daemon's control-plane isolate; the native backend has since reduced those
 * to one, so what stays off the control plane here is the burst processing. See createIsolatedWorkspaceWatch
 * for why the thread is kept regardless. */
const port = parentPort;
if (port === null) {
    throw new Error("workspace watch worker requires a parent port");
}
const { root } = workerData as { root: string };
const logger = {
    warn: (value: { err: unknown }) => {
        const error = value.err;
        port.postMessage({ kind: "error", message: errorMessage(error) });
    },
} as unknown as Logger;
const watcher = createWorkspaceWatch(root, logger);
watcher.subscribe((paths) => port.postMessage({ kind: "paths", paths }));

port.on("close", () => void watcher.close());
