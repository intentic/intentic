import type { WorkspaceChildrenResponse, WorkspaceFileResponse, WorkspaceTreeEntry, WorkspaceTreeResponse } from "@intentic-app/api-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { sandboxBlob, sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { errorMessage, useAsyncAction } from "../useAsyncAction";
import { resetUploadQueue } from "./useUploadQueue";

// Shared, module-level feedback for user file actions (rename, delete, save, move…) so the explorer, the tree
// rows, and the editor all report through ONE busy spinner + error line. Errors are surfaced, not thrown — a
// failed daemon call (denylist 404, escape 400, oversize 413) shouldn't blow up the DOM handler that fired it.
// Drag-drop uploads are NOT routed here; they go through useUploadQueue so a slow upload never blocks this line.
const { busy, error: actionError, run } = useAsyncAction();

// Lazily-loaded children of the dirs the tree walk listed but didn't descend into — ignored ones (node_modules,
// .git, …) and any that sat below the walk's breadth-first entry budget — keyed by the dir's root-relative path.
// Kept OUTSIDE the tree query so a tree refetch (the file watcher fires on any change) doesn't collapse an
// expanded lazy dir. `lazyHidden` counts entries the cap cut from a lazy listing; `lazyLoading` drives the
// per-row spinner.
const lazyChildren = ref<Map<string, readonly WorkspaceTreeEntry[]>>(new Map());
const lazyHidden = ref<Map<string, number>>(new Map());
const lazyLoading = ref<Set<string>>(new Set());

// Expanded directory paths (also the nest parents that fold sibling files, keyed by path). Module-level, next to
// the lazy subtrees above, so the explorer's toolbar (WorkspaceDesktop) and its context menu can Collapse All
// against the same set the tree rows toggle. Only consulted when not filtering — a filter force-expands matches.
const expanded = ref<ReadonlySet<string>>(new Set());
// The explorer's cut/copy clipboard — paths staged by Ctrl+X/Ctrl+C, consumed by the next paste. Module-level for
// the same reason `expanded` is: the tree component unmounts whenever the sidebar flips to Changes/Checkpoints or
// the search scope flips to Content, and a clipboard that died with it would make "copy here, look there, paste
// back" silently do nothing. Cleared on paste of a cut (the move consumed it) and on a sandbox switch below.
const clipboard = ref<{ readonly mode: "copy" | "cut"; readonly paths: readonly string[] } | undefined>(undefined);
// Collapse every open directory back to the roots (clears the whole set); nothing to reload since the tree data
// is untouched. No-op when already empty.
const collapseAll = (): void => {
    expanded.value = new Set();
};

// Clear the shared file-action feedback when the active sandbox changes (see sandboxScope) — a spinner or error
// from the previous sandbox must not bleed onto the next, and the upload queue + lazy-loaded subtrees are reset
// alongside it.
export const resetWorkspaceTreeState = (): void => {
    busy.value = false;
    actionError.value = undefined;
    lazyChildren.value = new Map();
    lazyHidden.value = new Map();
    lazyLoading.value = new Set();
    expanded.value = new Set();
    clipboard.value = undefined;
    resetUploadQueue();
};

/* The read-only "what the LLM sees" tree: the full /work filesystem the agent operates on, read DIRECTLY from
 * the sandbox daemon (GET /workspace/tree + /file — no platform-held state). The sandbox owns the ignore rules
 * and the secret denylist. Backed by vue-query so the tree is cached and refetchable; file reads stay
 * imperative (the viewer opens one on demand and manages its own object-URL lifecycle). */

// Flatten the nested tree to a path → entry map so the viewer can read a file's size/type in O(1) (to pick a
// render mode and gate large reads) without re-walking the nested tree on every open.
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
const basename = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const parentDir = (path: string): string => (path.includes(`/`) ? path.slice(0, path.lastIndexOf(`/`)) : ``);
// A folder can't move into itself, its own parent (a no-op), or one of its own descendants.
const canMoveInto = (source: string, targetDir: string): boolean =>
    !(targetDir === parentDir(source) || targetDir === source || targetDir.startsWith(`${source}/`));

const jsonPost = (path: string, data: unknown): Promise<{ ok: true }> =>
    sandboxJson<{ ok: true }>(path, { method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(data) });

// Raw single-path daemon calls (no invalidate) — the shared core for the single + batch mutations below.
const moveRaw = (from: string, to: string): Promise<{ ok: true }> => jsonPost(`/workspace/move`, { from, to });
const copyRaw = (from: string, to: string): Promise<{ ok: true }> => jsonPost(`/workspace/copy`, { from, to });
// oRPC's OpenAPI handler reads non-GET input from the request BODY (only GET reads the query), so a DELETE
// must carry {path} as a JSON body — a query param deserializes to undefined ("expected object").
const removeRaw = (path: string): Promise<unknown> =>
    sandboxJson(`/workspace/entry`, { method: `DELETE`, headers: { "content-type": `application/json` }, body: JSON.stringify({ path }) });

// The file's contents, or throws with a user-facing message (e.g. the daemon's denylist 404).
const readFile = async (path: string): Promise<string> => {
    const body = await sandboxJson<WorkspaceFileResponse>(`/workspace/file?path=${encodeURIComponent(path)}`);
    return body.content;
};

// Raw bytes for binary preview (images / PDF), where the text route's utf8 decode would corrupt the file.
const readBlob = (path: string): Promise<Blob> => sandboxBlob(`/workspace/raw?path=${encodeURIComponent(path)}`);

export function useWorkspaceTree() {
    const queryClient = useQueryClient();

    const { query, error } = useSandboxQuery({
        queryKey: computed(() => sandboxKey(`workspace`, `tree`)),
        queryFn: () => sandboxJson<WorkspaceTreeResponse>(`/workspace/tree`),
        // Fallback only: live freshness is pushed (the daemon's file watcher → /events SSE → markWorkspaceChanged
        // invalidates this query), so this poll is a backstop for a broken push chain, not the freshness path — a
        // slow 2min cap keeps steady-state traffic low while still self-healing if any link ever breaks.
        refetchInterval: 120_000,
    });

    // Every user file mutation below refreshes the tree immediately (no waiting on the file-watch push); the
    // shared query key means any open explorer repaints. targetDir/paths are root-relative — the same space the
    // tree and file routes speak. RAW prefix, not sandboxKey(): the sandbox id is APPENDED to query keys, so
    // ["workspace","tree"] prefix-matches every ["workspace","tree","all"|"filtered", id] (see useSandbox).
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: [`workspace`, `tree`] });
    // The editor's text save persists verbatim through the same upload route drag-drop uses (bulk drag-drop
    // uploads go through useUploadQueue). An emptied buffer writes an empty file. The tree refetch is fired but
    // NOT awaited: the caller must markSaved before the daemon's ~250ms file-watch echo re-reads the file, and a
    // slow tree walk here loses that race — the echo then compares against a stale baseline and raises a false
    // "changed on disk" warning. The echo's own push invalidates the tree anyway (markWorkspaceChanged), so this
    // kick is latency-only.
    // `baseHash` (sha256Hex of the text last read from disk) makes the save GUARDED: the daemon refuses it with
    // a 409 when the file changed since that read, so a save can't clobber a concurrent agent/terminal write.
    // Omitted for creates (no baseline exists yet) — those overwrite as before.
    const saveText = async (path: string, text: string, baseHash?: string): Promise<void> => {
        await sandboxJson<{ ok: true }>(`/workspace/upload?path=${encodeURIComponent(path)}`, {
            method: `POST`,
            headers: baseHash === undefined ? undefined : { "x-intentic-base-hash": baseHash },
            body: text,
        });
        void invalidate();
    };
    const createDir = async (path: string): Promise<void> => {
        await jsonPost(`/workspace/dir`, { path });
        await invalidate();
    };
    // Rename is the only genuinely single move (same parent, new name); every other delete/move/copy goes through a
    // batch variant so a multi-select mass action is one loop + a single trailing invalidate.
    const moveEntry = async (from: string, to: string): Promise<void> => {
        await moveRaw(from, to);
        await invalidate();
    };
    const removeEntries = async (paths: readonly string[]): Promise<void> => {
        for (const path of paths) {
            await removeRaw(path);
        }
        await invalidate();
    };
    const copyEntries = async (pairs: readonly { from: string; to: string }[]): Promise<void> => {
        for (const { from, to } of pairs) {
            await copyRaw(from, to);
        }
        await invalidate();
    };
    // Move each source INTO targetDir (drag-drop / cut-paste), skipping ones already there or that would nest a
    // folder inside itself; refetch once at the end.
    const moveIntoMany = async (sources: readonly string[], targetDir: string): Promise<void> => {
        for (const source of sources) {
            if (canMoveInto(source, targetDir)) {
                await moveRaw(source, joinPath(targetDir, basename(source)));
            }
        }
        await invalidate();
    };

    const tree = computed<readonly WorkspaceTreeEntry[]>(() => query.data.value?.tree ?? []);
    const root = computed(() => query.data.value?.root ?? ``);
    // How many of the ROOT's own entries the daemon's entry budget cut (0 = the root listing is complete).
    const rootHidden = computed(() => query.data.value?.hidden ?? 0);
    // The path → entry map spans the eager tree AND every lazily-loaded subtree, so the viewer can resolve
    // a lazily-shown file's size/type by path.
    const entriesByPath = computed(() => {
        const map = buildMap(tree.value);
        for (const entries of lazyChildren.value.values()) {
            for (const child of entries) {
                map.set(child.path, child);
            }
        }
        return map;
    });

    // The tree entry for a root-relative path (size/type), or undefined when not in the loaded tree.
    const entry = (path: string | undefined): WorkspaceTreeEntry | undefined => (path === undefined ? undefined : entriesByPath.value.get(path));

    // Lazy-load the children of a dir the walk left unlisted — ignored, or below the entry budget — on first
    // expand (no-op once loaded or already in flight). Errors surface on the shared actionError line, like the
    // file mutations above.
    const loadChildren = async (path: string): Promise<void> => {
        if (lazyChildren.value.has(path) || lazyLoading.value.has(path)) {
            return;
        }
        await fetchChildren(path);
    };
    const fetchChildren = async (path: string): Promise<void> => {
        lazyLoading.value.add(path);
        try {
            const body = await sandboxJson<WorkspaceChildrenResponse>(`/workspace/children?path=${encodeURIComponent(path)}`);
            lazyChildren.value.set(path, body.entries);
            if (body.hidden > 0) {
                lazyHidden.value.set(path, body.hidden);
            } else {
                lazyHidden.value.delete(path);
            }
        } catch (loadError) {
            actionError.value = errorMessage(loadError, `Failed to load ${path}.`);
        } finally {
            lazyLoading.value.delete(path);
        }
    };

    // A lazily-loaded subtree lives outside the tree query, so a tree refresh (a user mutation, or the daemon's
    // file-watch push) would leave it frozen at whatever it held when it was expanded — a file created inside an
    // open deep folder would simply never appear. Re-fetch every loaded lazy dir whenever the tree data lands, so
    // the eager and lazy halves of the explorer are always the same age. In-flight paths are skipped, and this
    // never re-enters: /workspace/children doesn't touch the tree query.
    watch(
        () => query.dataUpdatedAt.value,
        () => {
            for (const path of [...lazyChildren.value.keys()]) {
                if (!lazyLoading.value.has(path)) {
                    void fetchChildren(path);
                }
            }
        },
    );

    return {
        tree,
        root,
        rootHidden,
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
        createDir,
        moveEntry,
        removeEntries,
        copyEntries,
        moveIntoMany,
        busy,
        actionError,
        run,
    };
}
