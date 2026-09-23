import type { StorageCategoryId, StorageCleanResult, StorageReport } from "@intentic/sandbox-contract";
import { useAsyncAction } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { queryClient } from "../../../../lib/queryPersistence";
import { rpcQuery } from "../../client/rpcQuery";
import { sandboxRpc } from "../../client/sandboxRpc";
import { useSandboxQuery } from "../../client/useSandboxQuery";
import { useRole } from "../../secrets/useRole";
import { supportsRoute } from "../useDaemonRoutes";

// The Disk card's data: the daemon's last measurement, a scan that leaves it on screen until the new one lands, and a
// clean that measures again once it is done. The daemon holds the one scan, so a second window joins it.

export function useSandboxStorage() {
    const { canShip } = useRole();
    // Maintainer-floored at the daemon, and absent from a daemon older than the card.
    const available = computed(() => canShip.value && supportsRoute(`system.storage`));
    const read = rpcQuery(`system.storage`, undefined, { unpersisted: true });
    const { query, error } = useSandboxQuery({ ...read, enabled: available, staleTime: 0 });
    const scanning = useAsyncAction();
    const cleaning = useAsyncAction();
    const cleaned = ref<StorageCleanResult>();
    const cleaningCategory = ref<StorageCategoryId>();

    // A scan answers when it ends, however long that takes; the daemon's own time limit bounds it, not the tab's.
    const scan = (): Promise<void> =>
        scanning.run(async () => {
            const report = await sandboxRpc.system.scanStorage(undefined, { context: { deadline: false } });
            queryClient.setQueryData<StorageReport>(read.queryKey.value, report);
        }, t(`sandbox.useSandboxStorage.couldntMeasure`));

    // A failed cancel leaves the scan to run out on its own, which answers the waiting press anyway.
    const cancel = (): void => {
        void sandboxRpc.system.cancelStorageScan().catch(() => undefined);
    };

    const clean = async (category: StorageCategoryId, label: string): Promise<void> => {
        cleaned.value = undefined;
        cleaningCategory.value = category;
        await cleaning.run(async () => {
            cleaned.value = await sandboxRpc.system.cleanStorage({ category }, { context: { deadline: false } });
        }, t(`sandbox.useSandboxStorage.couldntClean`, { category: label }));
        cleaningCategory.value = undefined;
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
        scanNotice: scanning.notice,
        cleanNotice: cleaning.notice,
        cleaned,
        cleaningCategory,
        scan,
        cancel,
        clean,
    };
}
