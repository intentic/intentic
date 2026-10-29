import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { mapPool } from "@intentic/base/async";
import { useQueryClient } from "@tanstack/vue-query";
import { sandboxRef, sandboxScopeGuard, sandboxValue } from "@intentic/extension-api";
import { computed, watch } from "vue";
import { sandboxBlob } from "../../../client/sandbox/sandboxClient";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { opensAsFolder } from "../files/archiveEntries";
import { readFileWindow } from "../files/fileWindow";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useRole } from "../../../client/sandbox/useRole";
import { selfMember } from "../../../client/sandbox/useMembers";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { editFenceOf, fenceWrites, viewFence, writesSomewhere } from "./editScope";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { awaitingListing, dropProvisional, markSettled, noteArriving, noteLeaving, reconcileProvisional } from "../files/provisionalEntries";
import { renameOpenPaths } from "../tabs/useWorkspaceTabs";
import { type DeleteBatch, rememberCreated, rememberDelete, rememberMoves, type TrashedEntry } from "./deleteUndo";
import { type OperationKind, trackOperation } from "./fileOperations";
import { changedDirs, refreshWalkedTrees, treeRead } from "../changes/useWorkspaceLive";
import {
    clearLoadNotice,
    drawsListings,
    failedListing,
    followedByDeltas,
    forgetFollowed,
    lazyChildren,
    lazyHidden,
    lazyLoading,
    listingsSeen,
    loadChildren,
    relist,
    relistUnlessPushed,
    relistWhenSeen,
} from "./lazyListings";
import { actionError, busy, run } from "./treeActions";
import { useHome } from "../home/useHome";
import { readExpandedDirs, writeExpandedDirs } from "../tabs/workspaceSnapshot";
import { isShared, scopeFields, scopeQuery, workspaceView } from "../../../app/workspaceScope";
import { basename, joinPath, parentDir } from "@intentic/ui/path";
import { rpcPrefix } from "../../../lib/queryKeys";
import { workspaceTreeKey } from "./workspaceTreeKey";

// How long a confirmed write waits for the pushed delta before the listing is read again. The daemon re-lists its own
// writes as it answers them (the sandbox's workspace.routes.ts `wrote`), so this only runs out when that push was lost.
const HEAL_AFTER_MS = 3000;

// Writes in flight at once. Bounds a bulk delete against opening one connection per file, while keeping a wave of
// twenty a single round trip's wait rather than twenty.
const WRITE_POOL = 6;

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

// A folder can't move into itself, its own parent (a no-op), or one of its own descendants.
const canMoveInto = (source: string, targetDir: string): boolean =>
    !(targetDir === parentDir(source) || targetDir === source || targetDir.startsWith(`${source}/`));

// Reads again exactly what still disagrees with a write the daemon confirmed (afterWrite): a lazy folder's own listing,
// or the tree for anything in it. Disagreeing is an arrival missing from a folder whose listing is loaded (one never
// loaded has nothing to disagree with), or a departure still listed.
const healWrites = (
    paths: readonly string[],
    listed: ReadonlyMap<string, WorkspaceTreeEntry>,
    listingOf: (dir: string) => readonly WorkspaceTreeEntry[] | undefined,
    invalidate: () => Promise<void>,
): void => {
    const stale = paths.filter((path) => {
        const awaiting = awaitingListing(path);
        return awaiting === `arrival` ? !listed.has(path) && listingOf(parentDir(path)) !== undefined : awaiting === `departure` && listed.has(path);
    });
    const lazy = new Set(stale.map((path) => parentDir(path)).filter((dir) => lazyChildren.value.has(dir)));
    for (const dir of lazy) {
        relist(dir);
    }
    if (stale.some((path) => !lazy.has(parentDir(path)))) {
        void invalidate();
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

// Never older than the tree a pushed delta already patched in (useWorkspaceLive's treeRead).
export const fetchWorkspaceTree = treeRead(() => sandboxRpc.workspace.tree(scopeFields(workspaceView.value)));

/*
 * THE ONE PATH EVERY TREE WRITE TAKES. Each item's provisional rows are already on screen (the callers below note
 * them before the first byte moves), so this confirms or takes back each item's own rows on that item's own answer:
 * a bulk delete where three paths are refused keeps the seventeen that landed. What retires the rows is the listing
 * catching up (afterWrite). The first refusal is rethrown once every write has settled, so `run` reports it without
 * cancelling the rest. A gesture of many entries names its `kind`, which puts its progress and a Stop on a card
 * (fileOperations.ts); an entry not yet begun when Stop is pressed is left where it is, its rows taken back.
 */
const settleEachAfter =
    (afterWrite: (paths: readonly string[]) => void) =>
    async <T>(
        items: readonly T[],
        rows: (item: T) => readonly string[],
        write: (item: T) => Promise<unknown>,
        // Anything else this write moved ahead of the answer, put back. The rows are taken care of here; a move also
        // carries the open tabs, and one left at a name the daemon refused reads a file that isn't there and closes
        // itself, taking an unsaved buffer with it.
        undo?: (item: T) => void,
        kind?: OperationKind,
    ): Promise<void> => {
        let failure: { readonly cause: unknown } | undefined;
        const landed: string[] = [];
        const operation = trackOperation(kind, items.length);
        const takeBack = (item: T): void => {
            for (const path of rows(item)) {
                dropProvisional(path);
            }
            undo?.(item);
        };
        await mapPool(items, WRITE_POOL, async (item: T) => {
            if (operation.stopped()) {
                takeBack(item);
                return;
            }
            try {
                await write(item);
                for (const path of rows(item)) {
                    markSettled(path);
                    landed.push(path);
                }
                operation.landed(rows(item)[0] ?? ``, true);
            } catch (caught) {
                takeBack(item);
                operation.landed(rows(item)[0] ?? ``, false);
                failure ??= { cause: caught };
            }
        });
        operation.end();
        afterWrite(landed);
        if (failure !== undefined) {
            // Awaiting a rejection is how the daemon's own error leaves here unchanged; `throw` would need it narrowed.
            await Promise.reject(failure.cause);
        }
    };

export function useWorkspaceTree() {
    const queryClient = useQueryClient();
    // Where this member may change files by hand (editScope.ts): everywhere for the tiers that manage the sandbox,
    // nowhere below writer, and a writer's own edit areas otherwise, resolved to folders the way the daemon resolves
    // them. Every write verb is offered only where `canWriteAt` says yes, so nothing is drawn that would be refused.
    const { role } = useRole();
    const self = selfMember();
    // The manifest only matters for a writer whose edit names areas; everyone else's answer needs none of it.
    const namesAreas = computed(() => role.value === `writer` && Array.isArray(self.value?.edit));
    const { query: areasQuery } = useSandboxQuery({ ...rpcQuery(`areas.list`), enabled: namesAreas });
    const editFence = computed(() => viewFence(editFenceOf(role.value, self.value, areasQuery.data.value?.areas), isShared(workspaceView.value)));
    // Whether the member may change `path` (a file, or a folder and what goes in it).
    const canWriteAt = (path: string): boolean => fenceWrites(editFence.value, path);
    // Whether they may change anything at all: what decides a surface's read-only look as a whole.
    const canEditFiles = computed(() => writesSomewhere(editFence.value));

    const { query, error } = useSandboxQuery({
        queryKey: computed(() => workspaceTreeKey()),
        queryFn: fetchWorkspaceTree,
        // Fallback only: freshness is normally pushed (file-watch → SSE); this self-heals if that chain breaks.
        refetchInterval: 120_000,
    });

    // Invalidates every scope's tree (the procedure's whole prefix), so every scoped variant refetches, not just the
    // current one.
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: rpcPrefix(`workspace.tree`) });
    // `baseHash` 409s the save if the file changed since it was read; omitted for creates.
    const uploadText = (path: string, text: string, baseHash?: string): Promise<{ ok: true }> =>
        sandboxRaw(`POST /workspace/upload`, {
            query: { path },
            headers: baseHash === undefined ? undefined : { "x-intentic-base-hash": baseHash },
            input: text,
        });
    // An editor save: the row is already real, so nothing provisional is involved, and the shared tree takes the file's
    // new size from the delta pushed for it (afterWrite). Nothing is read back here, so callers markSaved before that
    // echo can race it into a false "changed on disk".
    const saveText = async (path: string, text: string, baseHash?: string): Promise<void> => {
        await uploadText(path, text, baseHash);
        refreshWalkedTrees();
    };

    /*
     * WHAT A WRITE ASKS OF THE LISTING. A walked checkout's tree is read again, since nothing pushes it. The shared tree
     * is NOT: it is the daemon's resident copy, and the delta that daemon pushes for this very write is what patches it.
     * Reading the whole tree the moment a write answered cost every paste a fetch of up to 5000 entries (~600 KB), and
     * that read was answered from before the write; when it landed after the delta it put the tree back the way it was,
     * so the row just pasted vanished until something else in the workspace moved. Only if the listing still disagrees
     * a moment later (a frame lost to a reconnect, an event the watcher dropped) is anything read again.
     */
    const afterWrite = (paths: readonly string[]): void => {
        refreshWalkedTrees();
        if (paths.length === 0) {
            return;
        }
        const here = sandboxScopeGuard();
        setTimeout(() => {
            if (here()) {
                healWrites(paths, entriesByPath.value, listingOf, invalidate);
            }
        }, HEAL_AFTER_MS);
    };

    const settleEach = settleEachAfter(afterWrite);

    // What a moved or copied entry draws as while it is provisional; a renamed folder must not arrive as a file.
    const typeOf = (path: string): "file" | "dir" => (entriesByPath.value.get(path)?.type === `dir` ? `dir` : `file`);

    const createDir = async (path: string): Promise<void> => {
        noteArriving(path, { kind: `write`, type: `dir` });
        await settleEach(
            [path],
            (dir) => [dir],
            (dir) => sandboxRpc.workspace.mkdir({ path: dir }),
        );
        rememberCreated([path]);
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
        rememberCreated([path]);
    };
    // Rename is the only single move (same parent, new name); every other op goes through a batch variant below. The
    // pair moves together: the old row goes and the new one arrives in the same frame, so nothing flickers between.
    // `remember` is false for a move that is itself an undo, which must not become the next thing Mod+Z takes back.
    const moveEntry = async (from: string, to: string, remember = true): Promise<void> => {
        noteLeaving(from);
        noteArriving(to, { kind: `write`, type: typeOf(from) });
        renameOpenPaths(from, to);
        await settleEach(
            [{ from, to }],
            (move) => [move.from, move.to],
            (move) => sandboxRpc.workspace.move(move),
            (move) => renameOpenPaths(move.to, move.from),
        );
        if (remember) {
            rememberMoves([{ from, to }]);
        }
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
                undefined,
                `delete`,
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
            undefined,
            `restore`,
        ).finally(() => rememberDelete({ entries: batch.entries.filter((entry) => !settled.has(entry.trashed)) }));
        return { landed, gone };
    };
    const copyEntries = async (pairs: readonly { from: string; to: string }[]): Promise<void> => {
        for (const { from, to } of pairs) {
            noteArriving(to, { kind: `write`, type: typeOf(from) });
        }
        const copied: string[] = [];
        await settleEach(
            pairs,
            (pair) => [pair.to],
            async (pair) => {
                await sandboxRpc.workspace.copy(pair);
                copied.push(pair.to);
            },
            undefined,
            `copy`,
        ).finally(() => rememberCreated(copied));
    };
    // Unpacks an archive beside itself and answers where it landed. No provisional row: only the daemon, which can see
    // inside the archive and knows which names are free, can say what the new entry is called.
    const extractEntry = async (path: string): Promise<string> => {
        const landed = await sandboxRpc.workspace.extract({ path });
        rememberCreated([landed.path]);
        await invalidate();
        return landed.path;
    };
    // Moves each source into targetDir, skipping ones already there or that would nest a folder in itself. `names` lands
    // a source under another name, where its own is taken there (a move's Keep Both, moveConflicts.ts); the daemon refuses
    // a move onto an entry already there rather than replacing it.
    const moveIntoMany = async (sources: readonly string[], targetDir: string, names?: ReadonlyMap<string, string>): Promise<void> => {
        const moves = sources
            .filter((source) => canMoveInto(source, targetDir))
            .map((source) => ({ from: source, to: joinPath(targetDir, names?.get(source) ?? basename(source)) }));
        for (const { from, to } of moves) {
            noteLeaving(from);
            noteArriving(to, { kind: `write`, type: typeOf(from) });
            renameOpenPaths(from, to);
        }
        const moved: (typeof moves)[number][] = [];
        await settleEach(
            moves,
            (move) => [move.from, move.to],
            async (move) => {
                await sandboxRpc.workspace.move(move);
                moved.push(move);
            },
            (move) => renameOpenPaths(move.to, move.from),
            `move`,
        ).finally(() => rememberMoves(moved));
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

    // Keeps the folder `dir` names listed while it is shown: one the walk skipped is asked for the moment it is looked at.
    const keepListed = (dir: () => string | undefined): void => {
        drawsListings();
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
    // Only where a listing is drawn and on screen (lazyListings.ts listingsSeen); a window that starts drawing one loads
    // its folders then.
    watch(
        [expanded, entriesByPath, listingsSeen],
        () => {
            if (!listingsSeen.value) {
                return;
            }
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
        const failed = failedListing();
        if (failed !== undefined && before.has(failed) && !dirs.has(failed)) {
            clearLoadNotice();
        }
    });

    // Lazy subtrees sit outside the tree query; refetch the ones being looked at whenever the tree data changes, or new
    // files never appear. Keyed on `query.data`, stable via structural sharing when unchanged, not `dataUpdatedAt`.
    // Only the ones on screen: a listing kept for a collapsed folder is re-read when it opens again, and a workspace
    // under a working agent invalidates this about once a second — re-listing every folder ever opened, each a readdir
    // and a stat per file, is how one open folder of several thousand files became a second of daemon time per second.
    watch(query.data, () => {
        // Iterating the live keys is safe: a read only writes this map after its first await.
        // One the deltas keep is current already: its own changes arrive in them (lazyListings.ts, patchListing).
        for (const path of lazyChildren.value.keys()) {
            if (onScreen(path) && !followedByDeltas(path)) {
                relistWhenSeen(path);
            }
        }
    });

    // The watch above can't see a write below the walk's budget: a file landing there leaves the eager tree identical,
    // so `query.data` never changes and the folder holding it would stay as it was listed. The file-watch batch names
    // the directory, so refetch exactly the loaded ones it touched (an empty batch means "unknown", so all of them).
    // A named one the deltas keep waits for its delta instead; an unknown batch may hide a missed delta, so all are read.
    watch(changedDirs, ({ dirs }) => {
        if (dirs.size === 0) {
            forgetFollowed();
        }
        for (const path of lazyChildren.value.keys()) {
            if (dirs.size === 0) {
                relistWhenSeen(path);
            } else if (dirs.has(path)) {
                relistUnlessPushed(path);
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
        // Waiting for the first snapshot, whatever holds it: a read in flight, or no read allowed yet because the sandbox
        // is not answering (useSandboxQuery holds every read until it is). vue-query's `isLoading` is false for a held
        // read, and an asleep sandbox opened at startup drew as an empty workspace for as long as it took to wake.
        isLoading: query.isPending,
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
        canWriteAt,
    };
}
