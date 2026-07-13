import type { FileDiffResponse, SnapshotDiffResponse, SnapshotsResponse } from "@intentic-app/api-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { sandboxJson } from "../sandboxClient";
import { resetEditBuffers } from "./useEditBuffers";
import { sandboxKey, useSandbox } from "../useSandbox";

/* Workspace history: the daemon's checkpoints of /work (agent turns labeled with the prompt, user changes,
 * restore markers — hidden interval captures never listed), read DIRECTLY from the sandbox like the workspace
 * tree. The list is vue-query cached; diff/fileDiff stay imperative (the panel loads them on demand). Restore
 * rewrites /work on the daemon, so it refreshes the snapshots, the tree, and drops stale edit buffers. */

const busy = ref(false);
const actionError = ref<string | undefined>(undefined);

const diff = (id: string): Promise<SnapshotDiffResponse> => sandboxJson<SnapshotDiffResponse>(`/history/diff?id=${encodeURIComponent(id)}`);
const fileDiff = (id: string, scope: string, path: string): Promise<FileDiffResponse> =>
    sandboxJson<FileDiffResponse>(
        `/history/file-diff?id=${encodeURIComponent(id)}&scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
    );

export function useHistory() {
    const { reachable } = useSandbox();
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: sandboxKey(`history`, `snapshots`),
        queryFn: () => sandboxJson<SnapshotsResponse>(`/history/snapshots`),
        enabled: reachable,
    });

    const snapshots = computed(() => query.data.value?.snapshots ?? []);
    const error = computed(() => (query.error.value ? query.error.value.message : undefined));

    const restore = async (id: string): Promise<void> => {
        actionError.value = undefined;
        busy.value = true;
        try {
            await sandboxJson(`/history/restore`, { method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify({ id }) });
            // /work changed underneath the UI: stale buffers would silently resurrect post-restore files on save.
            resetEditBuffers();
            // RAW prefix for the tree — its keys carry an "all"/"filtered" discriminator before the appended sandbox
            // id, so sandboxKey("workspace","tree") would NOT prefix-match them (see useSandbox). Snapshots have no
            // such discriminator, so the exact sandboxKey match is fine there.
            await queryClient.invalidateQueries({ queryKey: [`workspace`, `tree`] });
            await queryClient.invalidateQueries({ queryKey: sandboxKey(`history`, `snapshots`) });
            // A restore never moves the repos' HEADs, so the restored-vs-HEAD delta IS the new review set.
            await queryClient.invalidateQueries({ queryKey: sandboxKey(`git`, `changes`) });
        } catch (caught) {
            actionError.value = caught instanceof Error ? caught.message : `Restore failed.`;
        } finally {
            busy.value = false;
        }
    };

    return { snapshots, error, isLoading: query.isLoading, refetch: query.refetch, diff, fileDiff, restore, busy, actionError };
}
