import type { WorkspaceChildren, WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { sleep } from "@intentic/base/async";
import { type NoticeModel, noticeFrom } from "@intentic/ui/async";
import { sandboxRef, sandboxScopeGuard, sandboxValue } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { watch } from "vue";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { workspaceAgent } from "../../../app/workspaceScope";
import { actionError } from "./treeActions";

// The listings of folders the tree's walk left unopened (past its entry budget, or skipped like node_modules), each read
// on its own when someone looks at it. They sit outside the tree query, so useWorkspaceTree says when to read them again.

// Lazy children for dirs the walk skipped, keyed by path; kept outside the tree query to survive a refetch.
export const lazyChildren = sandboxRef(() => new Map<string, readonly WorkspaceTreeEntry[]>());
export const lazyHidden = sandboxRef(() => new Map<string, number>());
export const lazyLoading = sandboxRef(() => new Set<string>());
// Folders asked to be read again while a read of them was out (relist).
const relistQueued = sandboxValue(() => new Set<string>());
// Reads that left in this same turn. Every surface holding the tree answers one change with a relist of its own, and the
// read the first of them started already postdates that change, so the others have nothing to wait for.
const leftThisTurn = new Set<string>();
// The notice from a failed lazy load, and its dir; held by identity so it can't erase an unrelated later error. A
// switch takes the action notice down with it: whatever it named was in the tree being left. `busy` stays, since it
// counts writes still in flight, and each one decrements itself on the way out.
const loadNotice = sandboxValue<{ readonly path: string; readonly notice: NoticeModel } | undefined>(
    () => undefined,
    () => {
        actionError.value = undefined;
    },
);

// The folder whose failed read the showing notice is about, if one is.
export const failedListing = (): string | undefined => loadNotice.value?.path;

// Retires a lazy-load notice if it's still the one showing. Called when its dir loads, or when the scope it named goes
// away.
export const clearLoadNotice = (): void => {
    if (loadNotice.value !== undefined && actionError.value === loadNotice.value.notice) {
        actionError.value = undefined;
    }
    loadNotice.value = undefined;
};

// Lazy subtrees are keyed by path alone, so a scope switch must drop them (the tree query re-keys itself). Expanded
// folders are kept: the same paths are still correct.
watch(workspaceAgent, () => {
    lazyChildren.value = new Map();
    lazyHidden.value = new Map();
    lazyLoading.value = new Set();
    relistQueued.value.clear();
    // Also clears any load notice: it could still be naming a directory from the scope just dropped.
    clearLoadNotice();
});

// One directory's listing, retried once if the request never reached the daemon. A SandboxHttpError (the daemon refused
// it) is rethrown immediately, not retried.
const childrenOf = async (path: string): Promise<WorkspaceChildren> => {
    const request = (): Promise<WorkspaceChildren> => sandboxRpc.workspace.children({ path, agent: workspaceAgent.value });
    try {
        return await request();
    } catch (failure) {
        if (failure instanceof SandboxHttpError) {
            throw failure;
        }
        await sleep(300);
        return await request();
    }
};

// Loads a dir's children if the walk left it unlisted (no-op once loaded or in flight). Used directly by callers
// that need real contents without expanding the row (mobile drill-in, paste's name check).
export const loadChildren = async (path: string): Promise<void> => {
    if (lazyChildren.value.has(path) || lazyLoading.value.has(path)) {
        return;
    }
    await fetchChildren(path);
};
const fetchChildren = async (path: string): Promise<void> => {
    // Captures the scope before the request: a late answer must not land under a different scope's identical path,
    // whether the checkout or the whole sandbox moved.
    const asked = workspaceAgent.value;
    const current = sandboxScopeGuard();
    lazyLoading.value.add(path);
    leftThisTurn.add(path);
    queueMicrotask(() => leftThisTurn.delete(path));
    try {
        const body = await childrenOf(path);
        if (!current() || workspaceAgent.value !== asked) {
            return;
        }
        lazyChildren.value.set(path, body.entries);
        if (body.hidden > 0) {
            lazyHidden.value.set(path, body.hidden);
        } else {
            lazyHidden.value.delete(path);
        }
        // Retires the notice this same path's own failure raised, once it recovers.
        if (loadNotice.value?.path === path) {
            clearLoadNotice();
        }
    } catch (loadError) {
        // A read the user has already navigated away from doesn't get to raise an error for the tree shown now.
        if (!current() || workspaceAgent.value !== asked) {
            return;
        }
        const notice = noticeFrom(loadError, t(`workspace.useWorkspaceTree.couldntOpen`, { path }));
        loadNotice.value = { path, notice };
        actionError.value = notice;
    } finally {
        if (current()) {
            lazyLoading.value.delete(path);
            if (relistQueued.value.delete(path)) {
                void fetchChildren(path);
            }
        }
    }
};
// Reads a loaded folder's listing again. One already being read is read once more after it lands: that read may have
// left before the change this one is for, and skipping it let a listing from before a paste stand as the last word.
export const relist = (path: string): void => {
    if (lazyLoading.value.has(path)) {
        if (!leftThisTurn.has(path)) {
            relistQueued.value.add(path);
        }
        return;
    }
    void fetchChildren(path);
};
