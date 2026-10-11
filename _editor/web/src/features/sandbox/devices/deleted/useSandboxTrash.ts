import type { SandboxSummary, TrashedSandbox } from "@intentic/api-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { t } from "@intentic/ui/i18n";
import { SANDBOX_TRASH } from "../../../../lib/queryKeys";
import { apiClient } from "../../../../lib/useApi";
import { daysLeft } from "./trashWindow";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { useOperation } from "../../../../workbench/operations/operations";

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
    const readError = computed<string | undefined>(() => query.error.value?.message ?? undefined);

    // One restore at a time, in the operations ledger: the section opened again while the platform brings a machine
    // back holds every Restore button, and a refusal is still beside it. Which row is coming back is the run's tag.
    const restoration = useOperation<SandboxSummary>(`devices/trash/restore`);
    const restoring = computed(() => (restoration.busy.value ? restoration.operation.value?.tag : undefined));
    const failed = computed(() => {
        const failure = restoration.failure.value;
        return failure === undefined ? undefined : (failure.detail ?? failure.title);
    });
    // The registry's own refresh, not an invalidate on its key: the sandbox list is the one entry queryKeys.ts
    // deliberately gives no family, and refresh() is how everything else re-reads it. Taken here, in setup.
    const { refresh: refreshSandboxes } = useSandbox();

    // Brings one back and refreshes both lists: the sandbox appears in one as it leaves the other, and a stale
    // read of either would show the same box twice or not at all.
    const restore = async (trashId: string): Promise<SandboxSummary | undefined> => {
        if (restoration.busy.value) {
            return undefined;
        }
        const outcome = await restoration.run({
            what: t(`sandbox.recentlyDeleted.restoring`),
            tag: trashId,
            failed: t(`sandbox.recentlyDeleted.couldntRestore`),
            task: async () => {
                const restored = await apiClient.sandbox.restore({ trashId });
                await Promise.all([query.refetch(), refreshSandboxes()]);
                return restored;
            },
        });
        return outcome?.state === `done` ? outcome.value : undefined;
    };

    return {
        deleted,
        readError,
        // The rows worth drawing: a window that ran out between the fetch and this render promises nothing.
        recoverable: computed<readonly TrashedSandbox[]>(() => (deleted.value ?? []).filter((row) => daysLeft(row.purgeAfter) > 0)),
        restoring,
        failed,
        restore,
        refresh: query.refetch,
    };
}
