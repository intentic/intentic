import type { WorkspaceChildrenResponse, WorkspaceFileResponse, WorkspaceTreeEntry, WorkspaceTreeResponse } from "@intentic-app/api-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { sandboxBlob, sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey, useSandbox } from "../sandbox/useSandbox";
import { resetUploadQueue } from "./useUploadQueue";

// Shared, module-level feedback for user file actions (rename, delete, save, move…) so the explorer, the tree
// rows, and the editor all report through ONE busy spinner + error line. Errors are surfaced, not thrown — a
// failed daemon call (denylist 404, escape 400, oversize 413) shouldn't blow up the DOM handler that fired it.
// Drag-drop uploads are NOT routed here; they go through useUploadQueue so a slow upload never blocks this line.
const busy = ref(false);
const actionError = ref<string | undefined>(undefined);

// Lazily-loaded children of ignored dirs (node_modules, .git, …) the tree walk didn't descend into, keyed by the
// dir's root-relative path. Kept OUTSIDE the tree query so a tree refetch (the file watcher fires on any change)
// doesn't collapse an expanded ignored dir. `lazyTruncated` marks dirs whose child list hit the entry cap;
// `lazyLoading` drives the per-row spinner.
const lazyChildren = ref<Map<string, readonly WorkspaceTreeEntry[]>>(new Map());
const lazyTruncated = ref<Set<string>>(new Set());
const lazyLoading = ref<Set<string>>(new Set());

// Clear the shared file-action feedback when the active sandbox changes (see sandboxScope) — a spinner or error
// from the previous sandbox must not bleed onto the next, and the upload queue + lazy-loaded subtrees are reset
// alongside it.
export const resetWorkspaceTreeState = (): void => {
    busy.value = false;
    actionError.value = undefined;
    lazyChildren.value = new Map();
    lazyTruncated.value = new Set();
    lazyLoading.value = new Set();
    resetUploadQueue();
};

const runAction = async (fn: () => Promise<void>): Promise<void> => {
    actionError.value = undefined;
    busy.value = true;
    try {
        await fn();
    } catch (error) {
        actionError.value = error instanceof Error ? error.message : `Action failed.`;
    } finally {
        busy.value = false;
    }
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
    const { reachable } = useSandbox();
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: computed(() => sandboxKey(`workspace`, `tree`)),
        queryFn: () => sandboxJson<WorkspaceTreeResponse>(`/workspace/tree`),
        enabled: reachable,
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
    // uploads go through useUploadQueue). An emptied buffer writes an empty file.
    const saveText = async (path: string, text: string): Promise<void> => {
        await sandboxJson<{ ok: true }>(`/workspace/upload?path=${encodeURIComponent(path)}`, { method: `POST`, body: text });
        await invalidate();
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
    const truncated = computed(() => query.data.value?.truncated ?? false);
    // The path → entry map spans the eager tree AND every lazily-loaded ignored subtree, so the viewer can resolve
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
    const error = computed(() => (query.error.value ? query.error.value.message : null));

    // The tree entry for a root-relative path (size/type), or undefined when not in the loaded tree.
    const entry = (path: string | undefined): WorkspaceTreeEntry | undefined => (path === undefined ? undefined : entriesByPath.value.get(path));

    // Lazy-load an ignored dir's children on first expand (no-op once loaded or already in flight). Errors surface
    // on the shared actionError line, like the file mutations above.
    const loadChildren = async (path: string): Promise<void> => {
        if (lazyChildren.value.has(path) || lazyLoading.value.has(path)) {
            return;
        }
        lazyLoading.value.add(path);
        try {
            const body = await sandboxJson<WorkspaceChildrenResponse>(`/workspace/children?path=${encodeURIComponent(path)}`);
            lazyChildren.value.set(path, body.entries);
            if (body.truncated) {
                lazyTruncated.value.add(path);
            }
        } catch (loadError) {
            actionError.value = loadError instanceof Error ? loadError.message : `Failed to load ${path}.`;
        } finally {
            lazyLoading.value.delete(path);
        }
    };

    return {
        tree,
        root,
        truncated,
        entriesByPath,
        entry,
        error,
        isLoading: query.isLoading,
        refetch: query.refetch,
        readFile,
        readBlob,
        loadChildren,
        lazyChildren,
        lazyTruncated,
        lazyLoading,
        saveText,
        createDir,
        moveEntry,
        removeEntries,
        copyEntries,
        moveIntoMany,
        busy,
        actionError,
        runAction,
    };
}
