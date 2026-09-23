import type { FileDiffResponse, SnapshotDiffResponse } from "@intentic/api-contract";
import { sandboxScopeGuard, sandboxShallowRef } from "@intentic/extension-api";
import { useAsyncAction } from "@intentic/ui/async";
import { type QueryClient, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxRpc } from "../../../sandbox/client/sandboxRpc";
import { rpcQuery } from "../../../sandbox/client/rpcQuery";
import { useChat } from "../../../chat/run/useChat";
import { dropEditBuffers } from "../../files/useEditBuffers";
import { rpcKey, rpcPrefix, workingReviewKeys } from "../../../../lib/queryKeys";
import { useSandboxQuery } from "../../../sandbox/client/useSandboxQuery";

// Workspace history: the daemon's checkpoints of /work (turns, user changes, restores; hidden interval captures
// aren't listed). The snapshot list is vue-query cached; diff and fileDiff stay imperative, loaded on demand.
// Restore rewrites /work, so it refreshes snapshots and the tree and drops stale edit buffers.

// One sandbox's restores: a switch leaves a restore still running on the box it began on, its end and its failure that
// box's, and hands the next box a runner of its own.
const actions = sandboxShallowRef(() => useAsyncAction());

const diff = (id: string): Promise<SnapshotDiffResponse> => sandboxRpc.history.diff({ id });
const fileDiff = (id: string, scope: string, path: string): Promise<FileDiffResponse> => sandboxRpc.history.fileDiff({ id, scope, path });

// Shared by every /work rewrite (this restore, and chat's rewind mid-operation). The tree's whole prefix, since its
// scope is part of its key; a restore never moves HEAD, so the new diff is the new review set.
export const invalidateWorkspace = async (queryClient: QueryClient): Promise<void> => {
    // Stale buffers would silently resurrect post-restore files on save.
    dropEditBuffers();
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: rpcPrefix(`workspace.tree`) }),
        queryClient.invalidateQueries({ queryKey: rpcKey(`history.list`) }),
        ...workingReviewKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    ]);
};

// Standalone so surfaces without their own useHistory() can share it; caller supplies the scoped queryClient.
const restoreSnapshot = (queryClient: QueryClient, id: string): Promise<void> => {
    const here = sandboxScopeGuard();
    return actions.value.run(async () => {
        await sandboxRpc.history.restore({ id });
        // Switched away meanwhile: the box on screen was not the one restored, so nothing of it is refreshed or told.
        if (!here()) {
            return;
        }
        await invalidateWorkspace(queryClient);
        // Tells every non-isolated conversation /work moved underneath it; isolated chats use their own checkout.
        for (const conversation of useChat().conversations.value) {
            if (!conversation.isolated.value) {
                conversation.transcript.noteWorkspaceRestored();
            }
        }
    }, `Restore failed.`);
};

export function useHistory() {
    const queryClient = useQueryClient();

    const { query, error } = useSandboxQuery(rpcQuery(`history.list`));

    const snapshots = computed(() => query.data.value?.snapshots ?? []);

    const restore = (id: string): Promise<void> => restoreSnapshot(queryClient, id);

    return {
        snapshots,
        error,
        isLoading: query.isLoading,
        refetch: query.refetch,
        diff,
        fileDiff,
        restore,
        busy: computed(() => actions.value.busy.value),
        actionError: computed(() => actions.value.notice.value),
    };
}
