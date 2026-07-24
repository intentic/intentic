import { reactive } from "vue";
import { queryClient } from "../queryPersistence";
import { throttleTrailing } from "../throttleTrailing";

/* Live workspace-change state, fed from the daemon's /events SSE (useSandboxLiveness) and read by the tree
 * (auto-invalidate), the file viewer (re-read the open file), and the tree rows (transient highlight). The agent
 * edits /work out-of-band — its own Write/Edit/Bash tools, never the daemon's HTTP routes — so this push is the
 * only thing that keeps the view fresh without a manual Refresh. Module-level singleton so the SSE reader, which
 * runs outside any component, can push into the same signal every consumer watches. The tree invalidation happens
 * RIGHT HERE, against the module-singleton queryClient, not via a component-scoped watch — a watch installed from
 * a component dies with that component's effect scope (the /setup round-trip unmounts the shell; see
 * sandboxScope.ts for the same trap), which silently killed live refresh for the rest of the session. */

// How long a changed row stays highlighted after its last change.
const HIGHLIGHT_MS = 2000;
// One tree refetch per second while writes keep landing. The daemon batches its watcher at 250ms, so an upload or
// a build would otherwise walk the whole tree four times a second; a second of staleness is invisible to the eye,
// and the per-path epochs below (the open file's re-read, the row flash) stay instant regardless.
const TREE_REFRESH_MS = 1000;

// RAW prefix, not sandboxKey(): the sandbox id is APPENDED to query keys, so ["workspace","tree"] prefix-matches
// every ["workspace","tree","all"|"filtered", id] (see useSandbox).
const refreshTree = throttleTrailing(() => void queryClient.invalidateQueries({ queryKey: [`workspace`, `tree`] }), TREE_REFRESH_MS);

// Per-path change epoch: the file viewer includes changeEpochOf(openPath) in its read trigger, so an external
// edit re-reads the open file even when its byte length (and thus the tree entry's size) is unchanged.
const epochs = reactive(new Map<string, number>());
// Paths changed within the last HIGHLIGHT_MS, for the tree's transient row flash; each clears on its own timer.
const recentlyChanged = reactive(new Set<string>());
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();
let epoch = 0;

export const markWorkspaceChanged = (paths: readonly string[]): void => {
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
    // Always refetch, even for an empty batch — that's the daemon's "just refetch the tree" signal. Throttled (not
    // debounced): batches arrive continuously through an upload, and a debounce would keep resetting its timer and
    // never refresh at all — see throttleTrailing.
    refreshTree();
};

export const changeEpochOf = (path: string): number => epochs.get(path) ?? 0;
export const isRecentlyChanged = (path: string): boolean => recentlyChanged.has(path);
