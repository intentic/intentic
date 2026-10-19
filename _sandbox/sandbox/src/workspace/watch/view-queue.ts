import { errorMessage } from "@intentic/base/errors";
import type { WorkspaceTree } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";

// The watch thread's one line (workspace-watch-worker.ts): batches, rebuilds and asks in arrival order, so an answer
// never shows half of a batch. An ask for the tree joins the view at the line's tail while nothing that can move the
// tree has been queued behind it: a view of its own would be taken of exactly the same tree, so it is the same answer.
// Right after a boot every reloading tab's ask waits behind the first listing, and each then had its own copy of the
// whole tree made, one after another, by the thread that also re-lists every batch.

export interface ViewQueue {
    // Queues a step that can move the tree (a batch re-listed, everything listed again, the watch closing).
    readonly change: <T>(step: () => Promise<T> | T) => Promise<T>;
    // The tree as it stands after every change queued before this ask.
    readonly view: () => Promise<WorkspaceTree>;
    // Settles once everything queued before it has, moving nothing.
    readonly settled: () => Promise<void>;
}

// `first` heads the line; a step that fails is said through `failed` and never stops the ones behind it.
export const viewQueue = (first: Promise<unknown>, take: () => WorkspaceTree, failed: (message: string) => void): ViewQueue => {
    let queue: Promise<unknown> = first.catch((error: Error) => failed(errorMessage(error)));
    const after = <T>(step: () => Promise<T> | T): Promise<T> => {
        const done = queue.then(step);
        queue = done.catch((error: Error) => failed(errorMessage(error)));
        return done;
    };
    // The view at the tail, until a change is queued behind it; a view that failed is not shared.
    let tail: Promise<WorkspaceTree> | undefined;
    return {
        change: (step) => {
            tail = undefined;
            return after(step);
        },
        view: () => {
            if (tail === undefined) {
                const taking = after(take);
                tail = taking;
                // allow(silent-catch): every asker gets the failure through the view itself; this only stops it being shared.
                void taking.catch(() => {
                    if (tail === taking) {
                        tail = undefined;
                    }
                });
            }
            return tail;
        },
        settled: () => after(() => undefined),
    };
};
