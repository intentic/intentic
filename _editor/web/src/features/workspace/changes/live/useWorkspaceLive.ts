import type { SidecarStatus, WorkspaceTree, WorkspaceTreeDelta } from "@intentic/sandbox-contract";
import { parentDir } from "@intentic/ui/path";
import { sandboxRef, sandboxValue } from "@intentic/extension-api";
import { queryClient } from "../../../../lib/queryPersistence";
import { throttleTrailing } from "../../../../lib/throttleTrailing";
import { rpcPrefix } from "../../../../lib/queryKeys";
import { patchedTree } from "../../explorer/tree/treeDelta";

// Live workspace-change state fed from the daemon's SSE stream; consumed by the tree, the review lists' module
// grouping, the file viewer, and the tree's row flash. Module singleton so invalidation can't die with an unmounting
// component; sandbox-scoped, since paths collide across sandboxes and a stale epoch would wrongly skip a re-read.

// How long a changed row stays highlighted after its last change.
const HIGHLIGHT_MS = 2000;
// One tree refetch per second while writes land; the daemon already batches its watcher at 250ms.
const TREE_REFRESH_MS = 1000;
// Same window as the tree refresh; a manifest write rides the same write batches.
const MODULES_REFRESH_MS = 1000;

// A tree with a generation is the daemon's resident copy, kept current by `treeChanged`; only a walked checkout, which
// carries none, is fetched again when the watcher reports a batch. The whole prefix, since the scope is in the key.
const walkedTree = (data: unknown): boolean => (data as WorkspaceTree | undefined)?.generation === undefined;
const refreshTree = throttleTrailing(() => {
    for (const query of queryClient.getQueryCache().findAll({ queryKey: rpcPrefix(`workspace.tree`) })) {
        if (walkedTree(query.state.data)) {
            void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
        }
    }
}, TREE_REFRESH_MS);

/* WHAT MOVED IN THE SHARED TREE: every cached tree holding the generation the change counts from is patched in place;
   one holding another is fetched afresh, which is how a missed change heals. */
export const applyTreeChanged = (delta: WorkspaceTreeDelta): void => {
    for (const query of queryClient.getQueryCache().findAll({ queryKey: rpcPrefix(`workspace.tree`) })) {
        const tree = query.state.data as WorkspaceTree | undefined;
        if (tree === undefined || walkedTree(tree)) {
            continue;
        }
        const patched = patchedTree(tree, delta);
        if (patched === undefined) {
            void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
            continue;
        }
        queryClient.setQueryData(query.queryKey, patched);
    }
};
const refreshModules = throttleTrailing(() => void queryClient.invalidateQueries({ queryKey: rpcPrefix(`workspace.modules`) }), MODULES_REFRESH_MS);

// True only when a manifest could exist among the paths (or the batch is empty — the daemon's own "too many
// paths to list" signal, sent for a scaffold, branch switch, drop or reconnect too).
const mayChangeModules = (paths: readonly string[]): boolean =>
    paths.length === 0 || paths.some((path) => path === `package.json` || path.endsWith(`/package.json`));

/* DIRECTORIES THE LAST BATCH WROTE INTO, for listings the tree query can't refresh by itself: a lazily-loaded subtree
   sits outside that query, and a file landing in one leaves the eager tree byte-identical, so nothing else would say it
   arrived. An empty set is the daemon's own "too many paths to name" signal, and means any directory may have moved. */
export const changedDirs = sandboxRef<{ readonly stamp: number; readonly dirs: ReadonlySet<string> }>(() => ({ stamp: 0, dirs: new Set() }));

// Per-path change epoch: the file viewer's read trigger includes it, so a same-size external edit still re-reads.
const epochs = sandboxRef(() => new Map<string, number>());
// Paths changed within the last HIGHLIGHT_MS, for the tree's row flash; each clears on its own timer.
const recentlyChanged = sandboxRef(() => new Set<string>());
const clearTimers = sandboxValue(
    () => new Map<string, ReturnType<typeof setTimeout>>(),
    (previous) => previous.forEach((timer) => clearTimeout(timer)),
);
// Monotonic across sandboxes: an epoch only has to differ from the last one read for its path.
let epoch = 0;

// Evidence that a ref move also rewrote the tree (checkout/reset/rebase do both; a plain commit only moves
// the ref). Window is generous: a stale editor after a checkout is worse than a needless buffer drop after a commit.
const WORKTREE_MOVE_WINDOW_MS = 3000;
// A stale one would drop buffers on the next sandbox's first commit.
const lastWorkspaceChangeAt = sandboxRef(() => 0);
export const worktreeMovedRecently = (): boolean =>
    lastWorkspaceChangeAt.value !== 0 && Date.now() - lastWorkspaceChangeAt.value < WORKTREE_MOVE_WINDOW_MS;

// How many change batches the watcher has reported in this sandbox: a count, not a clock, since a batch arriving in the
// same millisecond as a verdict is still after it, and two millisecond stamps cannot say which came first. A ref: the
// push panel keeps a computed over it (whether its verdict has been written over), and a value the watcher mutated
// behind Vue's back would leave that answer frozen at whatever it first read.
const workspaceChanges = sandboxRef(() => 0);

/* WHERE THE TREE STANDS NOW, for anything about to hold a verdict about the files as they are. */
export const workspaceChangeMark = (): number => workspaceChanges.value;

/* WHETHER THE TREE HAS MOVED SINCE A MARK. True as well while no change was ever heard, since then nothing says the
   files are the ones the verdict was about. */
export const workspaceChangedSince = (mark: number): boolean => workspaceChanges.value === 0 || workspaceChanges.value > mark;

export const markWorkspaceChanged = (paths: readonly string[]): void => {
    lastWorkspaceChangeAt.value = Date.now();
    workspaceChanges.value += 1;
    for (const path of paths) {
        epochs.value.set(path, ++epoch);
        recentlyChanged.value.add(path);
        const existing = clearTimers.value.get(path);
        if (existing !== undefined) {
            clearTimeout(existing);
        }
        clearTimers.value.set(
            path,
            setTimeout(() => {
                recentlyChanged.value.delete(path);
                clearTimers.value.delete(path);
            }, HIGHLIGHT_MS),
        );
    }
    changedDirs.value = { stamp: changedDirs.value.stamp + 1, dirs: new Set(paths.map((path) => parentDir(path))) };
    // Refetches even on an empty batch (the daemon's signal); throttled not debounced so a steady upload still
    // refreshes.
    refreshTree();
    // A package appearing, renaming or vanishing makes module grouping wrong, not just stale, right when it matters
    // most.
    if (mayChangeModules(paths)) {
        refreshModules();
    }
};

export const changeEpochOf = (path: string): number => epochs.value.get(path) ?? 0;
export const isRecentlyChanged = (path: string): boolean => recentlyChanged.value.has(path);

/* A FILE'S TEXT LANDING, which no workspace change can stand in for: shadows are written under the state directory
   the watcher ignores, so `derivedChanged` is the only signal that a shadow was rewritten. Separate epochs from the
   ones above, since the two move independently — a file changing makes its text stale, its text landing does not
   change the file. */
const derivedEpochs = sandboxRef(() => new Map<string, number>());
// A sweep rewrites what it found and does not report which; this bumps for every path at once without enumerating one.
const sweepEpoch = sandboxRef(() => 0);
// Last reported state of the background pass, for anything explaining a wait rather than just waiting.
export const sidecarQueue = sandboxRef<SidecarStatus | undefined>(() => undefined);

export const markDerivedChanged = (paths: readonly string[], queue: SidecarStatus): void => {
    sidecarQueue.value = queue;
    if (paths.length === 0) {
        sweepEpoch.value += 1;
        return;
    }
    for (const path of paths) {
        derivedEpochs.value.set(path, ++epoch);
    }
};

/** Bumps when this file's derived text was rewritten, or when a sweep rewrote an unnamed set that may include it. */
export const derivedEpochOf = (path: string): number => (derivedEpochs.value.get(path) ?? 0) + sweepEpoch.value;
