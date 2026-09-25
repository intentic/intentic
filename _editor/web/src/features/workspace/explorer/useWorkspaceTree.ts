import type { WorkspaceChildrenResponse, WorkspaceTreeEntry, WorkspaceTreeResponse } from "@intentic/api-contract";
import { type NoticeModel, noticeFrom, noticeOf, useConcurrentActions } from "@intentic/ui/async";
import { mapPool } from "@intentic/base/async";
import { useQueryClient } from "@tanstack/vue-query";
import { sandboxRef, sandboxScopeGuard, sandboxValue } from "@intentic/extension-api";
import { computed, watch } from "vue";
import { sandboxBlob, sandboxJson } from "../../sandbox/client/sandboxClient";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { opensAsFolder } from "../files/archiveEntries";
import { readFileWindow } from "../files/fileWindow";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { useRole } from "../../sandbox/secrets/useRole";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { dropProvisional, markSettled, noteArriving, noteLeaving, reconcileProvisional } from "../files/provisionalEntries";
import { renameOpenPaths } from "../tabs/useWorkspaceTabs";
import { type DeleteBatch, rememberDelete, type TrashedEntry } from "./deleteUndo";
import { changedDirs } from "../changes/live/useWorkspaceLive";
import { useHome } from "../home/useHome";
import { readExpandedDirs, writeExpandedDirs } from "../tabs/workspaceSnapshot";
import { scopeQuery, workspaceAgent } from "../health/workspaceScope";
import { basename, parentDir } from "@intentic/ui/path";
import { rpcPrefix } from "../../../lib/queryKeys";
import { workspaceTreeKey } from "../health/workspaceTreeKey";
import { t } from "@intentic/ui/i18n";

// Shared busy/error state for file actions (rename, delete, save, move); drag-drop uploads use useUploadQueue.
// Concurrent, not mutexed: these are independent writes to different paths, and one runner shared by the tree, the
// mobile browser and the editor's Ctrl+S must never answer the second of two gestures by doing nothing.
const actions = useConcurrentActions();
const { busy, notice: actionError } = actions;

// A write's failure belongs to the sandbox it was made in: one that lands after a switch says nothing in the box
// switched to, whose tree it was never about. `busy` still counts it until it ends.
const run = (task: () => Promise<void>, wrote: string): Promise<void> => {
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

// Writes in flight at once. Bounds a bulk delete against opening one connection per file, while keeping a wave of
// twenty a single round trip's wait rather than twenty.
const WRITE_POOL = 6;

// Lazy children for dirs the walk skipped, keyed by path; kept outside the tree query to survive a refetch.
const lazyChildren = sandboxRef(() => new Map<string, readonly WorkspaceTreeEntry[]>());
const lazyHidden = sandboxRef(() => new Map<string, number>());
const lazyLoading = sandboxRef(() => new Set<string>());
// The notice from a failed lazy load, and its dir; held by identity so it can't erase an unrelated later error. A
// switch takes the action notice down with it: whatever it named was in the tree being left. `busy` stays, since it
// counts writes still in flight, and each one decrements itself on the way out.
const loadNotice = sandboxValue<{ readonly path: string; readonly notice: NoticeModel } | undefined>(
    () => undefined,
    () => {
        actionError.value = undefined;
    },
);

// Retires a lazy-load notice if it's still the one showing. Called when its dir loads, or when the scope it named goes
// away.
const clearLoadNotice = (): void => {
    if (loadNotice.value !== undefined && actionError.value === loadNotice.value.notice) {
        actionError.value = undefined;
    }
    loadNotice.value = undefined;
};

const { activeSandboxId } = useSandbox();
// Sandbox the open folders belong to, captured at restore rather than read live, to avoid a rescope race.
const scopedSandboxId = sandboxValue(() => activeSandboxId.value);
// Expanded directory paths (also folded nest-parents); ignored while filtering, persisted per sandbox and restored
// from there on a switch, so each folder comes back open where it was left.
const expanded = sandboxRef<ReadonlySet<string>>(() => new Set(readExpandedDirs(scopedSandboxId.value)));
// Whether a folder's listing is one someone is actually looking at: open in the tree, or the folder the home is showing.
// A lazy listing outlives the gesture that loaded it, so without this a folder opened once is re-read forever.
const { homeDir } = useHome();
const onScreen = (path: string): boolean => expanded.value.has(path) || homeDir.value === path;

watch(expanded, (dirs) => {
    if (scopedSandboxId.value !== undefined) {
        writeExpandedDirs(scopedSandboxId.value, [...dirs]);
    }
});
// Cut/copy clipboard; module-level so it survives the tree component unmounting on sidebar/search switches.
const clipboard = sandboxRef<{ readonly mode: "copy" | "cut"; readonly paths: readonly string[] } | undefined>(() => undefined);
// Collapses every open directory; no-op when already empty.
const collapseAll = (): void => {
    expanded.value = new Set();
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

// Read-only tree of the full /work filesystem, read directly from the sandbox daemon (workspace.tree), which owns
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

// One directory's listing, retried once if the request never reached the daemon. A SandboxHttpError (the daemon refused
// it) is rethrown immediately, not retried.
const childrenOf = async (path: string): Promise<WorkspaceChildrenResponse> => {
    const request = (): Promise<WorkspaceChildrenResponse> => sandboxRpc.workspace.children({ path, agent: workspaceAgent.value });
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

// File contents, or undefined if nothing is there; throws with a user-facing message if the read was refused. One
// window's worth, not the whole file (readFileWindow).
const readFile = async (path: string): Promise<string | undefined> => {
    const window = await readFileWindow(path);
    return window.present ? window.content : undefined;
};

// Raw bytes for binary preview (images / PDF), where the text route's utf8 decode would corrupt the file.
const readBlob = (path: string): Promise<Blob> => sandboxBlob(`/workspace/raw?${scopeQuery(new URLSearchParams({ path })).toString()}`);

export const fetchWorkspaceTree = (): Promise<WorkspaceTreeResponse> => sandboxRpc.workspace.tree({ agent: workspaceAgent.value });

export function useWorkspaceTree() {
    const queryClient = useQueryClient();
    // Whether this member may edit the shared tree; the daemon floors writes at writer, so others get read-only
    // access. Menus withdraw write items for them; refuseWrite reports the tier for actions with none to withdraw.
    // The tier, not the fence: a writer is offered every verb and is refused per path by the daemon, since only it
    // knows which areas that person holds.
    const { canWrite: canEditFiles } = useRole();
    const refuseWrite = (): boolean => {
        if (canEditFiles.value) {
            return false;
        }
        actionError.value = noticeOf(`Changing files needs writer access. Yours is read-only here.`);
        return true;
    };

    const { query, error } = useSandboxQuery({
        queryKey: computed(() => workspaceTreeKey()),
        queryFn: fetchWorkspaceTree,
        // Fallback only: freshness is normally pushed (file-watch → SSE); this self-heals if that chain breaks.
        refetchInterval: 120_000,
    });

    // Invalidates every scope's tree (the procedure's whole prefix), so every scoped variant refetches, not just the
    // current one.
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: rpcPrefix(`workspace.tree`) });
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
        await settleEach(
            [path],
            (dir) => [dir],
            (dir) => sandboxRpc.workspace.mkdir({ path: dir }),
        );
    };
    // A new, empty file. Same route as a save, but its row has to exist before the walk agrees and has to be taken back
    // if the write is refused, which is exactly what an editor save must not do.
    const createFile = async (path: string): Promise<void> => {
        noteArriving(path, { kind: `write`, type: `file` });
        await settleEach(
            [path],
            (file) => [file],
            (file) => uploadText(file, ``),
        );
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
            (move) => sandboxRpc.workspace.move(move),
            (move) => renameOpenPaths(move.to, move.from),
        );
    };
    // Each entry goes to the daemon's trash; the ones that went are remembered as one batch for Mod+Z, even when some
    // of the gesture was refused, and answered so a receipt's Undo can name exactly this delete.
    const removeEntries = async (paths: readonly string[]): Promise<DeleteBatch> => {
        const types = new Map(paths.map((path) => [path, typeOf(path)]));
        for (const path of paths) {
            noteLeaving(path);
        }
        const entries: TrashedEntry[] = [];
        const batch: DeleteBatch = { entries };
        try {
            await settleEach(
                paths,
                (path) => [path],
                async (path) => {
                    const { trashed } = await sandboxRpc.workspace.delete({ path });
                    if (trashed !== undefined) {
                        entries.push({ path, type: types.get(path) ?? `file`, trashed });
                    }
                },
            );
        } finally {
            rememberDelete(batch);
        }
        return batch;
    };
    // Puts a delete back, answering where each entry landed (beside its old name when something new took it) and how
    // many the trash no longer held. A row appears at once where the old one stood, unless that name is taken again.
    // What a failed request left in the trash goes back on the stack, so the next Mod+Z can try it again.
    const restoreDeleted = async (batch: DeleteBatch): Promise<{ readonly landed: readonly string[]; readonly gone: number }> => {
        const landed: string[] = [];
        const settled = new Set<string>();
        let gone = 0;
        const free = batch.entries.filter((entry) => !entriesByPath.value.has(entry.path));
        for (const entry of free) {
            noteArriving(entry.path, { kind: `write`, type: entry.type });
        }
        await settleEach(
            batch.entries,
            (entry) => (free.includes(entry) ? [entry.path] : []),
            async (entry) => {
                try {
                    const { path } = await sandboxRpc.workspace.restore({ trashed: entry.trashed });
                    landed.push(path);
                    settled.add(entry.trashed);
                } catch (failure) {
                    // Aged out of the trash, or already put back elsewhere: counted, not a failure of the rest.
                    if (failure instanceof SandboxHttpError && failure.status === 404) {
                        gone += 1;
                        settled.add(entry.trashed);
                        dropProvisional(entry.path);
                        return;
                    }
                    throw failure;
                }
            },
        ).finally(() => rememberDelete({ entries: batch.entries.filter((entry) => !settled.has(entry.trashed)) }));
        return { landed, gone };
    };
    const copyEntries = async (pairs: readonly { from: string; to: string }[]): Promise<void> => {
        for (const { from, to } of pairs) {
            noteArriving(to, { kind: `write`, type: typeOf(from) });
        }
        await settleEach(
            pairs,
            (pair) => [pair.to],
            (pair) => sandboxRpc.workspace.copy(pair),
        );
    };
    // Unpacks an archive beside itself and answers where it landed. No provisional row: only the daemon, which can see
    // inside the archive and knows which names are free, can say what the new entry is called.
    const extractEntry = async (path: string): Promise<string> => {
        const landed = await sandboxRpc.workspace.extract({ path });
        await invalidate();
        return landed.path;
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
            (move) => sandboxRpc.workspace.move(move),
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
    // A folder's listing as loaded, the walk's own or a lazy load's; undefined until one has it. "" is the root.
    const listingOf = (dir: string): readonly WorkspaceTreeEntry[] | undefined =>
        dir === `` ? tree.value : (entriesByPath.value.get(dir)?.children ?? lazyChildren.value.get(dir));
    // How many of a folder's own entries the daemon's entry budget cut from its listing.
    const hiddenIn = (dir: string): number => (dir === `` ? rootHidden.value : (lazyHidden.value.get(dir) ?? 0));

    // Loads a dir's children if the walk left it unlisted (no-op once loaded or in flight). Used directly by callers
    // that need real contents without expanding the row (mobile drill-in, paste's name check).
    const loadChildren = async (path: string): Promise<void> => {
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
            }
        }
    };

    // Keeps the folder `dir` names listed while it is shown: one the walk skipped is asked for the moment it is looked at.
    const keepListed = (dir: () => string | undefined): void => {
        watch(
            () => [dir(), listingOf(dir() ?? ``) === undefined] as const,
            ([path, unlisted]) => {
                if (path !== undefined && unlisted) {
                    void loadChildren(path);
                }
            },
            { immediate: true },
        );
    };

    // Loads children for any expanded dir the walk left unlisted, whether opened by a click or restored from the
    // snapshot. An expanded ARCHIVE loads the same way: it is a file, and what is inside it only ever arrives lazily.
    // Runs immediately: the tree can already be cached on mount, so waiting for the next change would leave it empty.
    watch(
        [expanded, entriesByPath],
        () => {
            for (const path of expanded.value) {
                const node = entriesByPath.value.get(path);
                if (node !== undefined && node.children === undefined && (node.type === `dir` || opensAsFolder(node))) {
                    void loadChildren(path);
                }
            }
        },
        { immediate: true },
    );

    // Closing the dir that failed retires its notice: the retry runs only while a dir is open, so a collapsed one would
    // never clear it.
    watch(expanded, (dirs, before) => {
        if (loadNotice.value !== undefined && before.has(loadNotice.value.path) && !dirs.has(loadNotice.value.path)) {
            clearLoadNotice();
        }
    });

    // Lazy subtrees sit outside the tree query; refetch the ones being looked at whenever the tree data changes, or new
    // files never appear. Keyed on `query.data`, stable via structural sharing when unchanged, not `dataUpdatedAt`.
    // Only the ones on screen: a listing kept for a collapsed folder is re-read when it opens again, and a workspace
    // under a working agent invalidates this about once a second — re-listing every folder ever opened, each a readdir
    // and a stat per file, is how one open folder of several thousand files became a second of daemon time per second.
    watch(query.data, () => {
        // Iterating the live keys is safe: fetchChildren only writes this map after its first await.
        for (const path of lazyChildren.value.keys()) {
            if (onScreen(path) && !lazyLoading.value.has(path)) {
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
        listingOf,
        hiddenIn,
        keepListed,
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
        restoreDeleted,
        copyEntries,
        moveIntoMany,
        extractEntry,
        busy,
        actionError,
        run,
        canEditFiles,
        refuseWrite,
    };
}
