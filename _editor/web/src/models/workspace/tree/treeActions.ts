import { useConcurrentActions } from "@intentic/ui/async";
import { sandboxScopeGuard } from "@intentic/extension-api";

// Shared busy/error state for file actions (rename, delete, save, move); drag-drop uploads use useUploadQueue.
// Concurrent, not mutexed: these are independent writes to different paths, and one runner shared by the tree, the
// mobile browser and the editor's Ctrl+S must never answer the second of two gestures by doing nothing.
const actions = useConcurrentActions();
export const { busy, notice: actionError } = actions;

// A write's failure belongs to the sandbox it was made in: one that lands after a switch says nothing in the box
// switched to, whose tree it was never about. `busy` still counts it until it ends.
export const run = (task: () => Promise<void>, wrote: string): Promise<void> => {
    const here = sandboxScopeGuard();
    return actions.run(async () => {
        try {
            await task();
        } catch (failure) {
            if (here()) {
                throw failure;
            }
        }
    }, wrote);
};
