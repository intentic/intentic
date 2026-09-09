import { reactive, ref } from "vue";
import { queryClient } from "../../../lib/queryPersistence";
import { throttleTrailing } from "../../../lib/throttleTrailing";
import { WORKSPACE_MODULES, WORKSPACE_TREE } from "../../../lib/queryKeys";

// Live workspace-change state fed from the daemon's SSE stream; consumed by the tree, the review lists' module
// grouping, the file viewer, and the tree's row flash — the only thing that keeps the view fresh since an
// agent edits /work outside any HTTP route. Module singleton so invalidation can't die with an unmounting component.

// How long a changed row stays highlighted after its last change.
const HIGHLIGHT_MS = 2000;
// One tree refetch per second while writes land; the daemon already batches its watcher at 250ms.
const TREE_REFRESH_MS = 1000;
// Same window as the tree refresh; a manifest write rides the same write batches.
const MODULES_REFRESH_MS = 1000;

// `.every`, not `.of()`: the tree key's scope prefix means only the wide match reaches every cached variant.
const refreshTree = throttleTrailing(() => void queryClient.invalidateQueries({ queryKey: WORKSPACE_TREE.every }), TREE_REFRESH_MS);
const refreshModules = throttleTrailing(() => void queryClient.invalidateQueries({ queryKey: WORKSPACE_MODULES.every }), MODULES_REFRESH_MS);

// True only when a manifest could exist among the paths (or the batch is empty — the daemon's own "too many
// paths to list" signal, sent for a scaffold, branch switch, drop or reconnect too).
const mayChangeModules = (paths: readonly string[]): boolean =>
    paths.length === 0 || paths.some((path) => path === `package.json` || path.endsWith(`/package.json`));

// Per-path change epoch: the file viewer's read trigger includes it, so a same-size external edit still re-reads.
const epochs = reactive(new Map<string, number>());
// Paths changed within the last HIGHLIGHT_MS, for the tree's row flash; each clears on its own timer.
const recentlyChanged = reactive(new Set<string>());
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();
let epoch = 0;

// Evidence that a ref move also rewrote the tree (checkout/reset/rebase do both; a plain commit only moves
// the ref). Window is generous: a stale editor after a checkout is worse than a needless buffer drop after a commit.
const WORKTREE_MOVE_WINDOW_MS = 3000;
// A ref rather than a plain stamp: the push panel keeps a computed over it (whether its verdict has been written
// over), and a value the watcher mutates behind Vue's back would leave that answer frozen at whatever it first read.
const lastWorkspaceChangeAt = ref(0);
export const worktreeMovedRecently = (): boolean =>
    lastWorkspaceChangeAt.value !== 0 && Date.now() - lastWorkspaceChangeAt.value < WORKTREE_MOVE_WINDOW_MS;

/* WHETHER THE TREE HAS MOVED SINCE A MOMENT, for anything holding a verdict about the files as they were: a red
 * pre-push check is the answer for exactly as long as nothing has been written (usePushFlow.ts). Answered from the
 * watcher rather than a digest of the change list, since an edit to an already-dirty file changes no path and no
 * count. Errs toward "changed": a dropped stream reconnects with the daemon's empty batch, which stamps this, so a
 * gap in the feed retires a verdict rather than vouching for one. Never having heard anything is not evidence of
 * quiet, so a zero stamp reads as changed too. */
export const workspaceChangedSince = (at: number): boolean => lastWorkspaceChangeAt.value === 0 || lastWorkspaceChangeAt.value > at;

export const markWorkspaceChanged = (paths: readonly string[]): void => {
    lastWorkspaceChangeAt.value = Date.now();
    for (const path of paths) {
        epochs.set(path, ++epoch);
        recentlyChanged.add(path);
        const existing = clearTimers.get(path);
        if (existing !== undefined) {
            clearTimeout(existing);
        }
        clearTimers.set(
            path,
            setTimeout(() => {
                recentlyChanged.delete(path);
                clearTimers.delete(path);
            }, HIGHLIGHT_MS),
        );
    }
    // Refetches even on an empty batch (the daemon's signal); throttled not debounced so a steady upload still
    // refreshes.
    refreshTree();
    // A package appearing, renaming or vanishing makes module grouping wrong, not just stale, right when it matters
    // most.
    if (mayChangeModules(paths)) {
        refreshModules();
    }
};

export const changeEpochOf = (path: string): number => epochs.get(path) ?? 0;
export const isRecentlyChanged = (path: string): boolean => recentlyChanged.has(path);

// Drops all per-path live state on switching sandboxes — paths collide across sandboxes, so a stale epoch would
// wrongly skip a re-read, and a stale `lastWorkspaceChangeAt` would drop buffers on the new one's first commit.
export const resetWorkspaceLive = (): void => {
    for (const timer of clearTimers.values()) {
        clearTimeout(timer);
    }
    clearTimers.clear();
    epochs.clear();
    recentlyChanged.clear();
    lastWorkspaceChangeAt.value = 0;
};
