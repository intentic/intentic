import type { WorkspaceChildrenResponse, WorkspaceTreeEntry, WorkspaceTreeResponse } from "@intentic/api-contract";
import { type NoticeModel, noticeFrom, noticeOf, useConcurrentActions } from "@intentic/ui/async";
import { mapPool } from "@intentic/base/async";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { SandboxHttpError, sandboxBlob, sandboxJson } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { readFileWindow } from "../files/fileWindow";
import { resetEmptyDirsState } from "./useEmptyDirs";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { useRole } from "../../sandbox/secrets/useRole";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { resetUploadQueue } from "../files/upload/useUploadQueue";
import { dropProvisional, markSettled, noteArriving, noteLeaving, reconcileProvisional, resetProvisional } from "../files/provisionalEntries";
import { renameOpenPaths } from "../tabs/useWorkspaceTabs";
import { changedDirs } from "../changes/live/useWorkspaceLive";
import { readExpandedDirs, writeExpandedDirs } from "../changes/workspaceSnapshot";
import { scopeQuery, workspaceAgent } from "../health/workspaceScope";
import { basename, parentDir } from "@intentic/ui/path";
import { WORKSPACE_TREE } from "../../../lib/queryKeys";

// Shared busy/error state for file actions (rename, delete, save, move); drag-drop uploads use useUploadQueue.
// Concurrent, not mutexed: these are independent writes to different paths, and one runner shared by the tree, the
// mobile browser and the editor's Ctrl+S must never answer the second of two gestures by doing nothing.
const { busy, notice: actionError, run } = useConcurrentActions();

// Writes in flight at once. Bounds a bulk delete against opening one connection per file, while keeping a wave of
// twenty a single round trip's wait rather than twenty.
const WRITE_POOL = 6;

// Lazy children for dirs the walk skipped, keyed by path; kept outside the tree query to survive a refetch.
const lazyChildren = ref<Map<string, readonly WorkspaceTreeEntry[]>>(new Map());
const lazyHidden = ref<Map<string, number>>(new Map());
const lazyLoading = ref<Set<string>>(new Set());
// The notice from a failed lazy load, and its dir; held by identity so it can't erase an unrelated later error.
let loadNotice: { readonly path: string; readonly notice: NoticeModel } | undefined;

// Retires a lazy-load notice if it's still the one showing. Called when its dir loads, or when the scope it named goes
// away.
const clearLoadNotice = (): void => {
    if (loadNotice !== undefined && actionError.value === loadNotice.notice) {
        actionError.value = undefined;
    }
    loadNotice = undefined;
};

// Expanded directory paths (also folded nest-parents); ignored while filtering, persisted per sandbox.
const expanded = ref<ReadonlySet<string>>(new Set());
// Sandbox the open folders belong to, captured at restore rather than read live, to avoid a rescope race.
let scopedSandboxId: string | undefined;
const { activeSandboxId } = useSandbox();

const restoreExpanded = (): void => {
    scopedSandboxId = activeSandboxId.value;
    expanded.value = new Set(readExpandedDirs(scopedSandboxId));
};
restoreExpanded();

watch(expanded, (dirs) => {
    if (scopedSandboxId !== undefined) {
        writeExpandedDirs(scopedSandboxId, [...dirs]);
    }
});
// Cut/copy clipboard; module-level so it survives the tree component unmounting on sidebar/search switches.
const clipboard = ref<{ readonly mode: "copy" | "cut"; readonly paths: readonly string[] } | undefined>(undefined);
// Collapses every open directory; no-op when already empty.
const collapseAll = (): void => {
    expanded.value = new Set();
};

// Resets file-action feedback and lazy state when the active sandbox changes. Open folders are re-scoped, not cleared:
// each one restores where it was left open.
// `busy` is not cleared: it counts writes still in flight, and each one decrements itself on the way out.
export const resetWorkspaceTreeState = (): void => {
    actionError.value = undefined;
    loadNotice = undefined;
    lazyChildren.value = new Map();
    lazyHidden.value = new Map();
    lazyLoading.value = new Set();
    clipboard.value = undefined;
    restoreExpanded();
    resetUploadQueue();
    // Placeholder rows belong to the tree they were dropped into; another sandbox's tree is not that tree.
    resetProvisional();
    resetEmptyDirsState();
};

// Lazy subtrees are keyed by path alone, so a scope switch must drop them (the tree query re-keys itself). Expanded
// folders are kept: the same paths are still correct.
watch(workspaceAgent, () => {
    lazyChildren.value = new Map();
    lazyHidden.value = new Map();
    lazyLoading.value = new Set();
    // Also clears any load notice: it could still be naming a directory from the scope just dropped.
    clearLoadNotice();
});

// Read-only tree of the full /work filesystem, read directly from the sandbox daemon (GET /workspace/tree), which owns
// the ignore rules and secret denylist. Backed by vue-query for caching; file reads stay imperative.

// Flattens the tree to a path → entry map so a file's size/type resolves in O(1) without re-walking the tree.
const buildMap = (nodes: readonly WorkspaceTreeEntry[]): Map<string, WorkspaceTreeEntry> => {
    const map = new Map<string, WorkspaceTreeEntry>();
    const walk = (list: readonly WorkspaceTreeEntry[]): void => {
        for (const node of list) {
            map.set(node.path, node);
            if (node.children) {
                walk(node.children);
            }
        }
    };
    walk(nodes);
    return map;
};

const joinPath = (dir: string, rel: string): string => (dir === `` ? rel : `${dir}/${rel}`);
// A folder can't move into itself, its own parent (a no-op), or one of its own descendants.
const canMoveInto = (source: string, targetDir: string): boolean =>
    !(targetDir === parentDir(source) || targetDir === source || targetDir.startsWith(`${source}/`));

const jsonPost = (path: string, data: unknown): Promise<{ ok: true }> => sandboxJson<{ ok: true }>(path, jsonBody(`POST`, data));

// One directory's listing, retried once if the request never reached the daemon. A SandboxHttpError (the daemon refused
// it) is rethrown immediately, not retried.
const childrenOf = async (path: string): Promise<WorkspaceChildrenResponse> => {
    const request = (): Promise<WorkspaceChildrenResponse> =>
        sandboxJson<WorkspaceChildrenResponse>(`/workspace/children?${scopeQuery(new URLSearchParams({ path })).toString()}`);
    try {
        return await request();
    } catch (failure) {
        if (failure instanceof SandboxHttpError) {
            throw failure;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        return await request();
    }
};

// Raw single-path daemon calls (no invalidate), the shared core for the single + batch mutations below.
const moveRaw = (from: string, to: string): Promise<{ ok: true }> => jsonPost(`/workspace/move`, { from, to });
const copyRaw = (from: string, to: string): Promise<{ ok: true }> => jsonPost(`/workspace/copy`, { from, to });
// oRPC's OpenAPI handler reads non-GET input from the body, not the query; DELETE must send {path} as JSON.
const removeRaw = (path: string): Promise<unknown> => sandboxJson(`/workspace/entry`, jsonBody(`DELETE`, { path }));

// File contents, or undefined if nothing is there; throws with a user-facing message if the read was refused. One
// window's worth, not the whole file (readFileWindow).
const readFile = async (path: string): Promise<string | undefined> => {
    const window = await readFileWindow(path);
    return window.present ? window.content : undefined;
};

// Raw bytes for binary preview (images / PDF), where the text route's utf8 decode would corrupt the file.
const readBlob = (path: string): Promise<Blob> => sandboxBlob(`/workspace/raw?${scopeQuery(new URLSearchParams({ path })).toString()}`);

// Scope is part of the query key, not just the request: different scopes are different trees, cached independently.
// Exported for the prefetch loader, which must read the scope live.
export const workspaceTreeKey = (): unknown[] => WORKSPACE_TREE.of(workspaceAgent.value ?? `shared`);

export const fetchWorkspaceTree = (): Promise<WorkspaceTreeResponse> =>
    sandboxJson<WorkspaceTreeResponse>(`/workspace/tree?${scopeQuery(new URLSearchParams()).toString()}`);

export function useWorkspaceTree() {
    const queryClient = useQueryClient();
    // Whether this member may edit the shared tree; the daemon floors writes at maintainer, so others get read-only
    // access. Menus withdraw write items for them; refuseWrite reports the tier for actions with none to withdraw.
    const { canShip: canEditFiles } = useRole();
    const refuseWrite = (): boolean => {
        if (canEditFiles.value) {
            return false;
        }
        actionError.value = noticeOf(`Changing files needs maintainer access. Yours is read-only here.`);
        return true;
    };

    const { query, error } = useSandboxQuery({
        queryKey: computed(() => workspaceTreeKey()),
        queryFn: fetchWorkspaceTree,
        // Fallback only: freshness is normally pushed (file-watch → SSE); this self-heals if that chain breaks.
        refetchInterval: 120_000,
    });

    // Invalidates the whole WORKSPACE_TREE family (`.every`, not `.of()`), so every scoped tree variant refetches, not
    // just the current one.
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: WORKSPACE_TREE.every });
    // Fires the tree refetch without awaiting it, so callers can markSaved before the file-watch echo races it into a
    // false "changed on disk". `baseHash` 409s the save if the file changed since it was read; omitted for creates.
    const uploadText = (path: string, text: string, baseHash?: string): Promise<{ ok: true }> =>
        sandboxJson<{ ok: true }>(`/workspace/upload?path=${encodeURIComponent(path)}`, {
            method: `POST`,
            headers: baseHash === undefined ? undefined : { "x-intentic-base-hash": baseHash },
            body: text,
        });
    // An editor save: the row is already real, so nothing provisional is involved.
    const saveText = async (path: string, text: string, baseHash?: string): Promise<void> => {
        await uploadText(path, text, baseHash);
        void invalidate();
    };

    /*
     * THE ONE PATH EVERY TREE WRITE TAKES. Each item's provisional rows are already on screen (the callers below note
     * them before the first byte moves), so this confirms or takes back each item's own rows on that item's own answer:
     * a bulk delete where three paths are refused keeps the seventeen that landed. The refetch is fired, never awaited
     * — it is a fresh walk of /work costing hundreds of milliseconds, and the rows it will paint are already painted.
     * The first refusal is rethrown once every write has settled, so `run` reports it without cancelling the rest.
     */
    const settleEach = async <T>(
        items: readonly T[],
        rows: (item: T) => readonly string[],
        write: (item: T) => Promise<unknown>,
        // Anything else this write moved ahead of the answer, put back. The rows are taken care of here; a move also
        // carries the open tabs, and one left at a name the daemon refused reads a file that isn't there and closes
        // itself, taking an unsaved buffer with it.
        undo?: (item: T) => void,
    ): Promise<void> => {
        let failure: { readonly cause: unknown } | undefined;
        await mapPool(items, WRITE_POOL, async (item: T) => {
            try {
                await write(item);
                for (const path of rows(item)) {
                    markSettled(path);
                }
            } catch (caught) {
                for (const path of rows(item)) {
                    dropProvisional(path);
                }
                undo?.(item);
                failure ??= { cause: caught };
            }
        });
        void invalidate();
        if (failure !== undefined) {
            // Awaiting a rejection is how the daemon's own error leaves here unchanged; `throw` would need it narrowed.
            await Promise.reject(failure.cause);
        }
    };

    // What a moved or copied entry draws as while it is provisional; a renamed folder must not arrive as a file.
    const typeOf = (path: string): "file" | "dir" => (entriesByPath.value.get(path)?.type === `dir` ? `dir` : `file`);

    const createDir = async (path: string): Promise<void> => {
        noteArriving(path, { kind: `write`, type: `dir` });
        await settleEach([path], (dir) => [dir], (dir) => jsonPost(`/workspace/dir`, { path: dir }));
    };
    // A new, empty file. Same route as a save, but its row has to exist before the walk agrees and has to be taken back
    // if the write is refused, which is exactly what an editor save must not do.
    const createFile = async (path: string): Promise<void> => {
        noteArriving(path, { kind: `write`, type: `file` });
        await settleEach([path], (file) => [file], (file) => uploadText(file, ``));
    };
    // Rename is the only single move (same parent, new name); every other op goes through a batch variant below. The
    // pair moves together: the old row goes and the new one arrives in the same frame, so nothing flickers between.
    const moveEntry = async (from: string, to: string): Promise<void> => {
        noteLeaving(from);
        noteArriving(to, { kind: `write`, type: typeOf(from) });
        renameOpenPaths(from, to);
        await settleEach(
            [{ from, to }],
            (move) => [move.from, move.to],
            (move) => moveRaw(move.from, move.to),
            (move) => renameOpenPaths(move.to, move.from),
        );
    };
    const removeEntries = async (paths: readonly string[]): Promise<void> => {
        for (const path of paths) {
            noteLeaving(path);
        }
        await settleEach(paths, (path) => [path], removeRaw);
    };
    const copyEntries = async (pairs: readonly { from: string; to: string }[]): Promise<void> => {
        for (const { from, to } of pairs) {
            noteArriving(to, { kind: `write`, type: typeOf(from) });
        }
        await settleEach(pairs, (pair) => [pair.to], (pair) => copyRaw(pair.from, pair.to));
    };
    // Moves each source into targetDir, skipping ones already there or that would nest a folder in itself.
    const moveIntoMany = async (sources: readonly string[], targetDir: string): Promise<void> => {
        const moves = sources
            .filter((source) => canMoveInto(source, targetDir))
            .map((source) => ({ from: source, to: joinPath(targetDir, basename(source)) }));
        for (const { from, to } of moves) {
            noteLeaving(from);
            noteArriving(to, { kind: `write`, type: typeOf(from) });
            renameOpenPaths(from, to);
        }
        await settleEach(
            moves,
            (move) => [move.from, move.to],
            (move) => moveRaw(move.from, move.to),
            (move) => renameOpenPaths(move.to, move.from),
        );
    };

    const tree = computed<readonly WorkspaceTreeEntry[]>(() => query.data.value?.tree ?? []);
    // True once a snapshot has loaded, even an empty one; use this, not tree.length, to detect "not yet loaded".
    const hasSnapshot = computed(() => query.data.value !== undefined);
    const root = computed(() => query.data.value?.root ?? ``);
    // How many of the root's own entries the daemon's entry budget cut (0 = listing is complete).
    const rootHidden = computed(() => query.data.value?.hidden ?? 0);
    // Folders containing only empty folders, workspace-wide; not derivable from `tree` since budget cuts hide it.
    const barren = computed<readonly string[]>(() => query.data.value?.barren ?? []);
    // Eager tree walk, cached separately so a lazy subtree landing doesn't re-walk the whole eager tree each time.
    const eagerByPath = computed(() => buildMap(tree.value));
    // Path → entry map spanning the eager tree and every lazy subtree, so a lazily-shown file resolves by path.
    const entriesByPath = computed(() => {
        const map = new Map(eagerByPath.value);
        for (const entries of lazyChildren.value.values()) {
            for (const child of entries) {
                map.set(child.path, child);
            }
        }
        return map;
    });

    // The tree entry for a root-relative path (size/type), or undefined when not in the loaded tree.
    const entry = (path: string | undefined): WorkspaceTreeEntry | undefined => (path === undefined ? undefined : entriesByPath.value.get(path));

    // Loads a dir's children if the walk left it unlisted (no-op once loaded or in flight). Used directly by callers
    // that need real contents without expanding the row (mobile drill-in, paste's name check).
    const loadChildren = async (path: string): Promise<void> => {
        if (lazyChildren.value.has(path) || lazyLoading.value.has(path)) {
            return;
        }
        await fetchChildren(path);
    };
    const fetchChildren = async (path: string): Promise<void> => {
        // Captures the scope before the request: a late answer must not land under a different scope's identical path.
        const asked = workspaceAgent.value;
        lazyLoading.value.add(path);
        try {
            const body = await childrenOf(path);
            if (workspaceAgent.value !== asked) {
                return;
            }
            lazyChildren.value.set(path, body.entries);
            if (body.hidden > 0) {
                lazyHidden.value.set(path, body.hidden);
            } else {
                lazyHidden.value.delete(path);
            }
            // Retires the notice this same path's own failure raised, once it recovers.
            if (loadNotice?.path === path) {
                clearLoadNotice();
            }
        } catch (loadError) {
            // A read the user has already navigated away from doesn't get to raise an error for the tree shown now.
            if (workspaceAgent.value !== asked) {
                return;
            }
            const notice = noticeFrom(loadError, `Couldn't open ${path}.`);
            loadNotice = { path, notice };
            actionError.value = notice;
        } finally {
            lazyLoading.value.delete(path);
        }
    };

    // Loads children for any expanded dir the walk left unlisted, whether opened by a click or restored from the
    // snapshot. Runs immediately: the tree can already be cached on mount, so waiting for the next change would leave
    // it empty.
    watch(
        [expanded, entriesByPath],
        () => {
            for (const path of expanded.value) {
                const node = entriesByPath.value.get(path);
                if (node?.type === `dir` && node.children === undefined) {
                    void loadChildren(path);
                }
            }
        },
        { immediate: true },
    );

    // Closing the dir that failed retires its notice: the retry runs only while a dir is open, so a collapsed one would
    // never clear it.
    watch(expanded, (dirs, before) => {
        if (loadNotice !== undefined && before.has(loadNotice.path) && !dirs.has(loadNotice.path)) {
            clearLoadNotice();
        }
    });

    // Lazy subtrees sit outside the tree query; refetch each loaded one whenever the tree data changes, or new files
    // never appear. Keyed on `query.data`, stable via structural sharing when unchanged, not `dataUpdatedAt`.
    watch(query.data, () => {
        // Iterating the live keys is safe: fetchChildren only writes this map after its first await.
        for (const path of lazyChildren.value.keys()) {
            if (!lazyLoading.value.has(path)) {
                void fetchChildren(path);
            }
        }
    });

    // The watch above can't see a write below the walk's budget: a file landing there leaves the eager tree identical,
    // so `query.data` never changes and the folder holding it would stay as it was listed. The file-watch batch names
    // the directory, so refetch exactly the loaded ones it touched (an empty batch means "unknown", so all of them).
    watch(changedDirs, ({ dirs }) => {
        for (const path of lazyChildren.value.keys()) {
            if ((dirs.size === 0 || dirs.has(path)) && !lazyLoading.value.has(path)) {
                void fetchChildren(path);
            }
        }
    });

    // Retires every provisional row the moment the listing agrees with it: an arrival once the path is listed, a
    // departure once it is gone. This is the only thing that ends one, so a refused write must take its own row back.
    watch(entriesByPath, (entries) => reconcileProvisional((path: string) => entries.has(path)), { immediate: true });

    return {
        tree,
        hasSnapshot,
        root,
        rootHidden,
        barren,
        entriesByPath,
        entry,
        error,
        isLoading: query.isLoading,
        refetch: query.refetch,
        readFile,
        readBlob,
        loadChildren,
        expanded,
        collapseAll,
        clipboard,
        lazyChildren,
        lazyHidden,
        lazyLoading,
        saveText,
        createFile,
        createDir,
        moveEntry,
        removeEntries,
        copyEntries,
        moveIntoMany,
        busy,
        actionError,
        run,
        canEditFiles,
        refuseWrite,
    };
}
