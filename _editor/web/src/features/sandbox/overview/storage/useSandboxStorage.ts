import type { StorageCategoryId, StorageCleanResult, StorageReport } from "@intentic/sandbox-contract/schemas/metrics";
import { t } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { queryClient } from "../../../../lib/queryPersistence";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { useRole } from "../../../../client/sandbox/useRole";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { useOperation } from "../../../../workbench/operations/operations";

// The Disk card's data: the daemon's last measurement, a scan that leaves it on screen until the new one lands, and a
// clean that measures again once it is done. The daemon holds the one scan, so a second window joins it. Both runs
// are the sandbox's, kept in the operations ledger: a clean takes as long as the folder is big, and the card opened
// again meanwhile holds its buttons and then says what it freed.

export function useSandboxStorage() {
    const { canShip } = useRole();
    // Maintainer-floored at the daemon, and absent from a daemon older than the card.
    const available = computed(() => canShip.value && supportsRoute(`system.storage`));
    const read = rpcQuery(`system.storage`, undefined, { unpersisted: true });
    const { query, error } = useSandboxQuery({ ...read, enabled: available, staleTime: 0 });
    const scanning = useOperation(`sandbox/storage/scan`);
    const cleaning = useOperation<StorageCleanResult>(`sandbox/storage/clean`);
    // Which category is being cleaned, by the run's own tag.
    const cleaningCategory = computed(() => (cleaning.busy.value ? (cleaning.operation.value?.tag as StorageCategoryId | undefined) : undefined));

    // A scan answers when it ends, however long that takes; the daemon's own time limit bounds it, not the tab's.
    // Quiet: its end is the card's own figures changing.
    const scan = async (): Promise<void> => {
        await scanning.run({
            what: t(`sandbox.sandboxStorageCard.measuring`),
            failed: t(`sandbox.useSandboxStorage.couldntMeasure`),
            quiet: true,
            task: async () => {
                const report = await sandboxRpc.system.scanStorage(undefined, { context: { deadline: false } });
                queryClient.setQueryData<StorageReport>(read.queryKey.value, report);
            },
        });
    };

    // A failed cancel leaves the scan to run out on its own, which answers the waiting press anyway.
    const cancel = (): void => {
        void sandboxRpc.system.cancelStorageScan().catch(() => undefined);
    };

    const clean = async (category: StorageCategoryId, label: string): Promise<void> => {
        if (cleaning.busy.value) {
            return;
        }
        await cleaning.run({
            what: t(`sandbox.useSandboxStorage.cleaning`, { category: label }),
            tag: category,
            failed: t(`sandbox.useSandboxStorage.couldntClean`, { category: label }),
            task: () => sandboxRpc.system.cleanStorage({ category }, { context: { deadline: false } }),
        });
        // What the clean freed is only true of the disk once measured again.
        await scan();
    };

    // Another window's scan is this one's too: joining it is how this card learns when it ends.
    watch(
        () => query.data.value?.scanning === true,
        (elsewhere) => {
            if (elsewhere && !scanning.busy.value) {
                void scan();
            }
        },
    );

    return {
        available,
        report: computed(() => query.data.value),
        loading: computed(() => query.isLoading.value),
        readError: error,
        scanning: computed(() => scanning.busy.value || query.data.value?.scanning === true),
        scanNotice: scanning.failure,
        cleanNotice: cleaning.failure,
        cleaned: cleaning.value,
        cleaningCategory,
        scan,
        cancel,
        clean,
    };
}
