import { reactive } from "vue";
import { queryClient } from "../queryPersistence";
import { throttleTrailing } from "../throttleTrailing";

/* Live workspace-change state, fed from the daemon's /events SSE (useSandboxLiveness) and read by the tree
 * (auto-invalidate), the review lists' module grouping (auto-invalidate), the file viewer (re-read the open file),
 * and the tree rows (transient highlight). The agent edits /work out-of-band — its own Write/Edit/Bash tools,
 * never the daemon's HTTP routes — so this push is the only thing that keeps the view fresh without a manual
 * Refresh. Module-level singleton so the SSE reader, which runs outside any component, can push into the same
 * signal every consumer watches. The invalidations happen RIGHT HERE, against the module-singleton queryClient,
 * not via a component-scoped watch — a watch installed from a component dies with that component's effect scope
 * (the /setup round-trip unmounts the shell; see sandboxScope.ts for the same trap), which silently killed live
 * refresh for the rest of the session. */

// How long a changed row stays highlighted after its last change.
const HIGHLIGHT_MS = 2000;
// One tree refetch per second while writes keep landing. The daemon batches its watcher at 250ms, so an upload or
// a build would otherwise walk the whole tree four times a second; a second of staleness is invisible to the eye,
// and the per-path epochs below (the open file's re-read, the row flash) stay instant regardless.
const TREE_REFRESH_MS = 1000;
// Same window for the package layout, and for the same reason: the batches that carry a manifest write are the
// same continuous batches an install or a scaffold produces.
const MODULES_REFRESH_MS = 1000;

// RAW prefix, not sandboxKey(): the sandbox id is APPENDED to query keys, so ["workspace","tree"] prefix-matches
// every ["workspace","tree","all"|"filtered", id] (see useSandbox).
const refreshTree = throttleTrailing(() => void queryClient.invalidateQueries({ queryKey: [`workspace`, `tree`] }), TREE_REFRESH_MS);
const refreshModules = throttleTrailing(() => void queryClient.invalidateQueries({ queryKey: [`workspace`, `modules`] }), MODULES_REFRESH_MS);

/* Could this batch have changed WHICH PACKAGES EXIST? A manifest is the only file that decides that (see the
 * daemon's workspace/modules.ts), so an ordinary source write costs nothing here — which is what lets the
 * modules query keep its long hold instead of re-walking every repo on every batch.
 *
 * The empty batch counts. It is the daemon's "more paths than a frame carries" signal — a scaffold, a branch
 * switch, a drop — and a reconnect sends one too, so a package created while the browser was away arrives
 * exactly this way, unnamed. */
const mayChangeModules = (paths: readonly string[]): boolean =>
    paths.length === 0 || paths.some((path) => path === `package.json` || path.endsWith(`/package.json`));

// Per-path change epoch: the file viewer includes changeEpochOf(openPath) in its read trigger, so an external
// edit re-reads the open file even when its byte length (and thus the tree entry's size) is unchanged.
const epochs = reactive(new Map<string, number>());
// Paths changed within the last HIGHLIGHT_MS, for the tree's transient row flash; each clears on its own timer.
const recentlyChanged = reactive(new Set<string>());
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();
let epoch = 0;

/* When the last workspace-change batch landed — the evidence that a ref move ALSO swapped the working tree.
 *
 * A checkout, a reset or a rebase rewrites files and so arrives as both a `workspaceChanged` batch and a
 * `refsChanged` frame; a plain commit moves only the ref and leaves the tree byte-identical. The two frames are
 * pushed by independent watchers, so "did files move too" cannot be read off the refs frame itself — this is
 * what systemEvents consults before dropping the editor's buffers, because dropping them after an ordinary
 * commit would cost the user an unsaved edit for nothing.
 *
 * The window is generous on purpose: both watchers debounce (250ms each) and the two batches are not ordered
 * against each other, so the file batch can land either side of the refs frame. Erring long risks a needless
 * buffer drop after a commit that happened to follow a save; erring short risks a stale editor after a
 * checkout, which is the worse of the two.
 */
const WORKTREE_MOVE_WINDOW_MS = 3000;
let lastWorkspaceChangeAt = 0;
export const worktreeMovedRecently = (): boolean => lastWorkspaceChangeAt !== 0 && Date.now() - lastWorkspaceChangeAt < WORKTREE_MOVE_WINDOW_MS;

export const markWorkspaceChanged = (paths: readonly string[]): void => {
    lastWorkspaceChangeAt = Date.now();
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
    /* A package appearing, being renamed away, or being deleted is the one thing that makes the review lists'
     * module grouping WRONG rather than merely old — and it is wrong at the worst moment, because a new
     * package's files are all changes at once. Without this push they group under the repo's own name with
     * their paths shortened to bare filenames, for as long as the layout's hold lasts. */
    if (mayChangeModules(paths)) {
        refreshModules();
    }
};

export const changeEpochOf = (path: string): number => epochs.get(path) ?? 0;
export const isRecentlyChanged = (path: string): boolean => recentlyChanged.has(path);
