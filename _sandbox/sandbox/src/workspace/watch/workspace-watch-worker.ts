import { parentPort, workerData } from "node:worker_threads";
import { errorMessage } from "@intentic/base/errors";
import type { WorkspaceTreeDelta } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { post, serveCalls } from "../../workers/worker-calls.js";
import { createResidentTree } from "../files/resident-tree.js";
import { createWorkspaceWatch, type WatchAsk, type WatchNews } from "./workspace-watch.js";

/* The recursive watcher's owner, and the resident tree's: every batch is re-listed here, off the daemon's loop. */
const port = parentPort;
if (port === null) {
    throw new Error("workspace watch worker requires a parent port");
}
const { root } = workerData as { root: string };

// A watcher can miss what a link's target did, or an event it dropped under load; listing everything again this often
// is what heals the tree of either.
const RECONCILE_MS = 600_000;

const news = (message: WatchNews): void => post(port, { news: message });
const report = (error: unknown): void => news({ kind: "error", message: errorMessage(error) });
const tree = createResidentTree(root);
const announce = (delta: WorkspaceTreeDelta | undefined): void => {
    if (delta !== undefined) {
        news({ kind: "tree", delta });
    }
};

const watcher = createWorkspaceWatch(root, { warn: ({ err }: { err: unknown }) => report(err) } as unknown as Logger);

// Batches and asks in arrival order, so an answer never shows half of a batch; the first waits for the first listing
// and the armed watcher both, so a change made after any answer is one the tree will hear of.
let queue: Promise<unknown> = Promise.all([tree.ready, watcher.ready]).catch(report);
const after = <T>(step: () => Promise<T> | T): Promise<T> => {
    const done = queue.then(step);
    queue = done.catch(report);
    return done;
};
watcher.subscribe((paths) => {
    news({ kind: "paths", paths });
    void after(async () => announce(await tree.apply(paths)));
});
serveCalls<WatchAsk & { readonly id: number }>(port, (ask) => after(() => (ask.kind === "view" ? tree.view() : undefined)));
setInterval(() => void after(async () => announce(await tree.rebuild())), RECONCILE_MS).unref();

port.on("close", () => void watcher.close());
