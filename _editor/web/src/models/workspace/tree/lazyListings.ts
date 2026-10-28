import type { WorkspaceChildren, WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { sleep } from "@intentic/base/async";
import { type NoticeModel, noticeFrom } from "@intentic/ui/async";
import { sandboxRef, sandboxScopeGuard, sandboxValue } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { computed, getCurrentScope, onScopeDispose, ref, watch } from "vue";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { workspaceAgent } from "../../../app/workspaceScope";
import { actionError } from "./treeActions";
import { onScreen as windowOnScreen } from "../../../workbench/window/onScreen";

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
    unseenChanges.value.clear();
    forgetFollowed();
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

/* WHETHER ANYBODY HERE SEES A LISTING. Every window composes the tree store (the floating chat and the sign-in gate
   included) and restores its expanded folders from the storage every window shares, so a window drawing no tree at all
   loaded every expanded folder the walk skipped and read each again on every change in it, and so did a window nobody
   could see: the steadiest daemon call in every window, hidden ones included (2026-10-27). A listing is read while a
   surface drawing listings is mounted in a window on screen; a change landing while none is, is read once one is. */

// allow(module-state): how many surfaces this window has mounted that draw a folder's listing; a sandbox switch keeps them
const listingViews = ref(0);

/** Whether this window draws a folder listing that is on screen now. */
export const listingsSeen = computed(() => listingViews.value > 0 && windowOnScreen.value);

/** Counts the calling component as drawing listings for as long as its scope lives: a tree, the home's folder, a look. */
export const drawsListings = (): void => {
    if (getCurrentScope() === undefined) {
        return;
    }
    listingViews.value += 1;
    onScopeDispose(() => {
        listingViews.value -= 1;
    });
};

// Loaded folders a change touched while no listing here could be seen.
const unseenChanges = sandboxValue(() => new Set<string>());

/** `relist` while a listing here can be seen; otherwise the folder is read once one can. */
export const relistWhenSeen = (path: string): void => {
    if (listingsSeen.value) {
        relist(path);
        return;
    }
    unseenChanges.value.add(path);
};

watch(listingsSeen, (seen) => {
    if (!seen) {
        return;
    }
    const missed = [...unseenChanges.value];
    unseenChanges.value.clear();
    for (const path of missed) {
        if (lazyChildren.value.has(path)) {
            relist(path);
        }
    }
});

/* LISTINGS THE PUSHED DELTAS KEEP. The daemon's resident tree re-lists a folder it holds when a batch touches it, and
   pushes that folder's entries in its delta (useWorkspaceLive's applyTreeChanged): the same entries a read of the folder
   would answer. A loaded folder a delta has carried once is kept by deltas from then on, so a change a batch names waits
   a moment for the delta that follows it instead of reading the folder again. Reading it again fetched a folder of fifty
   thousand entries (about 5 MB) twice per change: once pushed and thrown away, once read. A delta that never comes (a
   folder the resident tree stopped holding, a frame lost) is read after the wait, and the folder is read on every change
   again until a delta carries it. Only the shared tree has deltas; a conversation's own checkout is read as before. */
const DELTA_WAIT_MS = 2000;
const followed = sandboxValue(() => new Set<string>());
const awaitingDelta = sandboxValue(
    () => new Map<string, ReturnType<typeof setTimeout>>(),
    (held) => held.forEach((timer) => clearTimeout(timer)),
);

/** Takes a loaded folder's entries from a pushed delta, and keeps following it by deltas; false for one not loaded here. */
export const patchListing = (path: string, entries: readonly WorkspaceTreeEntry[]): boolean => {
    if (workspaceAgent.value !== undefined || !lazyChildren.value.has(path)) {
        return false;
    }
    lazyChildren.value.set(path, entries);
    lazyHidden.value.delete(path);
    followed.value.add(path);
    clearTimeout(awaitingDelta.value.get(path));
    awaitingDelta.value.delete(path);
    return true;
};

/** Whether deltas keep this loaded folder current, so a change elsewhere in the tree need not read it again. */
export const followedByDeltas = (path: string): boolean => followed.value.has(path);

/** A batch named this loaded folder: wait for the delta that keeps it, or read it again where deltas do not. */
export const relistUnlessPushed = (path: string): void => {
    if (!followed.value.has(path)) {
        relistWhenSeen(path);
        return;
    }
    if (awaitingDelta.value.has(path)) {
        return;
    }
    awaitingDelta.value.set(
        path,
        setTimeout(() => {
            awaitingDelta.value.delete(path);
            followed.value.delete(path);
            relistWhenSeen(path);
        }, DELTA_WAIT_MS),
    );
};

/** Stops trusting deltas for every folder, which are read again on the next change: one may have been missed. */
export const forgetFollowed = (): void => {
    followed.value.clear();
    awaitingDelta.value.forEach((timer) => clearTimeout(timer));
    awaitingDelta.value.clear();
};
