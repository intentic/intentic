import type { FileDiffResponse, SnapshotDiffResponse, SnapshotsResponse } from "@intentic/api-contract";
import { useAsyncAction } from "@intentic/ui/async";
import { type QueryClient, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { useChat } from "../../chat/run/useChat";
import { resetEditBuffers } from "../files/useEditBuffers";
import { GIT_CHANGES, HISTORY_SNAPSHOTS, WORKSPACE_TREE } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";

// Workspace history: the daemon's checkpoints of /work (turns, user changes, restores; hidden interval captures
// aren't listed). The snapshot list is vue-query cached; diff and fileDiff stay imperative, loaded on demand.
// Restore rewrites /work, so it refreshes snapshots and the tree and drops stale edit buffers.

const { busy, notice: actionError, run } = useAsyncAction();

const diff = (id: string): Promise<SnapshotDiffResponse> => sandboxJson<SnapshotDiffResponse>(`/history/diff?id=${encodeURIComponent(id)}`);
const fileDiff = (id: string, scope: string, path: string): Promise<FileDiffResponse> =>
    sandboxJson<FileDiffResponse>(
        `/history/file-diff?id=${encodeURIComponent(id)}&scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
    );

// Shared by every /work rewrite (this restore, and chat's rewind mid-operation). `.every` for the tree since
// its keys don't prefix-match under `.of()`; a restore never moves HEAD, so the new diff is the new review set.
export const invalidateWorkspace = async (queryClient: QueryClient): Promise<void> => {
    // Stale buffers would silently resurrect post-restore files on save.
    resetEditBuffers();
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: WORKSPACE_TREE.every }),
        queryClient.invalidateQueries({ queryKey: HISTORY_SNAPSHOTS.of() }),
        queryClient.invalidateQueries({ queryKey: GIT_CHANGES.of() }),
    ]);
};

// Standalone so surfaces without their own useHistory() can share it; caller supplies the scoped queryClient.
const restoreSnapshot = (queryClient: QueryClient, id: string): Promise<void> =>
    run(async () => {
        await sandboxJson(`/history/restore`, jsonBody(`POST`, { id }));
        await invalidateWorkspace(queryClient);
        // Tells every non-isolated conversation /work moved underneath it; isolated chats use their own checkout.
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
