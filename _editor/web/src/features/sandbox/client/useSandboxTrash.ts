import type { SandboxSummary, TrashedSandbox } from "@intentic/api-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { SANDBOX_TRASH } from "../../../lib/queryKeys";
import { apiClient } from "../../../lib/useApi";
import { daysLeft } from "./trashWindow";
import { useSandbox } from "./useSandbox";

// Sandboxes this account deleted and can still have back. Account-wide, like the sandbox list itself, and never
// persisted to disk: a row here names a machine the platform is still holding.

export function useSandboxTrash() {
    const query = useQuery({
        queryKey: SANDBOX_TRASH.every,
        queryFn: async (): Promise<TrashedSandbox[]> => (await apiClient.sandbox.trash()).sandboxes,
        staleTime: 60_000,
        retry: 1,
    });

    // Undefined while unread, so a surface can tell "nothing deleted" from "not asked yet".
    const deleted = computed<readonly TrashedSandbox[] | undefined>(() => query.data.value);

    const restoring = ref<string | undefined>(undefined);
    const failed = ref<string | undefined>(undefined);

    // Brings one back and refreshes both lists: the sandbox appears in one as it leaves the other, and a stale
    // read of either would show the same box twice or not at all.
    const restore = async (trashId: string): Promise<SandboxSummary | undefined> => {
        if (restoring.value !== undefined) {
            return undefined;
        }
        restoring.value = trashId;
        failed.value = undefined;
        try {
            const restored = await apiClient.sandbox.restore({ trashId });
            // The registry's own refresh, not an invalidate on its key: the sandbox list is the one entry
            // queryKeys.ts deliberately gives no family, and refresh() is how everything else re-reads it.
            await Promise.all([query.refetch(), useSandbox().refresh()]);
            return restored;
        } catch (error) {
            failed.value = error instanceof Error ? error.message : String(error);
            return undefined;
        } finally {
            restoring.value = undefined;
        }
    };

    return {
        deleted,
        // The rows worth drawing: a window that ran out between the fetch and this render promises nothing.
        recoverable: computed<readonly TrashedSandbox[]>(() => (deleted.value ?? []).filter((row) => daysLeft(row.purgeAfter) > 0)),
        restoring,
        failed,
        restore,
        refresh: query.refetch,
    };
}
