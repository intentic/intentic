import type { SnapshotDiffResponse, SnapshotFileDiffResponse, SnapshotsResponse } from "@intentic-app/api-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { sandboxJson } from "../sandboxClient";
import { resetEditBuffers } from "./useEditBuffers";
import { sandboxKey, useSandbox } from "../useSandbox";

/* Workspace history: the daemon's auto-captured snapshots of /work (per agent turn + a periodic sweep), read
 * DIRECTLY from the sandbox like the workspace tree. The list is vue-query cached; diff/fileDiff stay
 * imperative (the panel loads them on demand). Restore rewrites /work on the daemon, so it refreshes the
 * snapshots, the tree, and drops stale edit buffers. */

const busy = ref(false);
const actionError = ref<string | undefined>(undefined);

// `base` (optional) diffs a snapshot against an earlier one — the aggregate change since then (the Changes review
// panel); omitted, it diffs against the snapshot's own parent (the History timeline's per-snapshot view).
const baseParam = (base?: string): string => (base !== undefined ? `&base=${encodeURIComponent(base)}` : ``);

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

    const diff = (id: string, base?: string): Promise<SnapshotDiffResponse> =>
        sandboxJson<SnapshotDiffResponse>(`/history/diff?id=${encodeURIComponent(id)}${baseParam(base)}`);
    const fileDiff = (id: string, scope: string, path: string, base?: string): Promise<SnapshotFileDiffResponse> =>
        sandboxJson<SnapshotFileDiffResponse>(
            `/history/file-diff?id=${encodeURIComponent(id)}&scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}${baseParam(base)}`,
        );

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
        } catch (error) {
            actionError.value = error instanceof Error ? error.message : `Restore failed.`;
        } finally {
            busy.value = false;
        }
    };

    return { snapshots, error, isLoading: query.isLoading, refetch: query.refetch, diff, fileDiff, restore, busy, actionError };
}
