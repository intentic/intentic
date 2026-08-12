import type { FileDiffResponse, SnapshotDiffResponse, SnapshotsResponse } from "@intentic-app/api-contract";
import { useAsyncAction } from "@intentic/ui/async";
import { type QueryClient, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";
import { useChat } from "../chat/useChat";
import { resetEditBuffers } from "./useEditBuffers";
import { GIT_CHANGES, HISTORY_SNAPSHOTS, WORKSPACE_TREE } from "../queryKeys";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* Workspace history: the daemon's checkpoints of /work (agent turns labeled with the prompt, user changes,
 * restore markers — hidden interval captures never listed), read DIRECTLY from the sandbox like the workspace
 * tree. The list is vue-query cached; diff/fileDiff stay imperative (the panel loads them on demand). Restore
 * rewrites /work on the daemon, so it refreshes the snapshots, the tree, and drops stale edit buffers. */

const { busy, notice: actionError, run } = useAsyncAction();

const diff = (id: string): Promise<SnapshotDiffResponse> => sandboxJson<SnapshotDiffResponse>(`/history/diff?id=${encodeURIComponent(id)}`);
const fileDiff = (id: string, scope: string, path: string): Promise<FileDiffResponse> =>
    sandboxJson<FileDiffResponse>(
        `/history/file-diff?id=${encodeURIComponent(id)}&scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
    );

/* WHAT EVERY SURFACE HAS TO DO ONCE /work HAS BEEN REWRITTEN UNDER IT — shared because there is now more than
 * one thing that rewrites it: the timeline's restore below, and the chat bubble's rewind, which restores
 * daemon-side as one step of a larger operation and so cannot go through the POST above.
 *
 * `.every` for the tree — its keys carry the focused scope before the appended sandbox id, so `.of()` would
 * NOT prefix-match them (see queryKeys). Snapshots and changes have no such variant, so the sandbox-scoped
 * `.of()` is the right reach there. A restore never moves the repos' HEADs, so the restored-vs-HEAD delta IS
 * the new review set. Disjoint caches — refetch concurrently. */
export const invalidateWorkspace = async (queryClient: QueryClient): Promise<void> => {
    // Stale buffers would silently resurrect post-restore files on save.
    resetEditBuffers();
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: WORKSPACE_TREE.every }),
        queryClient.invalidateQueries({ queryKey: HISTORY_SNAPSHOTS.of() }),
        queryClient.invalidateQueries({ queryKey: GIT_CHANGES.of() }),
    ]);
};

// The restore action, standalone so surfaces without their own useHistory() can share it — the caller supplies
// the setup-scoped queryClient.
export const restoreSnapshot = (queryClient: QueryClient, id: string): Promise<void> =>
    run(async () => {
        await sandboxJson(`/history/restore`, jsonBody(`POST`, { id }));
        await invalidateWorkspace(queryClient);
        /* AND TELL THE CHATS THAT WERE WATCHING. This restore rewrote /work, which is the workspace every
         * main-tree conversation is reasoning about — their contexts now describe files that changed underneath
         * them, and until this line the only evidence was the next turn behaving oddly. The timeline and the
         * transcript are two views of one history, so a move made in either has to be visible from the other.
         *
         * Isolated chats are left alone: they work in checkouts of their own, which this did not touch. */
        for (const conversation of useChat().conversations.value) {
            if (!conversation.isolated.value) {
                conversation.noteWorkspaceRestored();
            }
        }
    }, `Restore failed.`);

export function useHistory() {
    const queryClient = useQueryClient();

    const { query, error } = useSandboxQuery({
        queryKey: HISTORY_SNAPSHOTS.of(),
        queryFn: () => sandboxJson<SnapshotsResponse>(`/history/snapshots`),
    });

    const snapshots = computed(() => query.data.value?.snapshots ?? []);

    const restore = (id: string): Promise<void> => restoreSnapshot(queryClient, id);

    return { snapshots, error, isLoading: query.isLoading, refetch: query.refetch, diff, fileDiff, restore, busy, actionError };
}
