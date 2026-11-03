import type { StorageCleanResult } from "@intentic/sandbox-contract/schemas/metrics";
import { computed } from "vue";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { useRole } from "../../../../client/sandbox/useRole";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { t } from "@intentic/ui/i18n";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { useOperation } from "../../../../workbench/operations/operations";
import { storageCategoryLabel } from "./storageCategories";

// The daemon's disk-pressure watch, as the attention list reads it: how full the history volume is, what the sandbox
// already removed to make room, and the one press that removes the rest of the settled checkouts' build output. The
// daemon pushes the `disk` domain when the level moves, so this never polls.

export function useDiskPressure() {
    const { canShip } = useRole();
    // Maintainer-floored at the daemon, like the Disk card, and absent from a daemon older than the watch.
    const available = computed(() => canShip.value && supportsRoute(`system.diskPressure`));
    const { query } = useSandboxQuery({ ...rpcQuery(`system.diskPressure`), enabled: available });
    // The Disk card's own clean run (useSandboxStorage), so the card opened meanwhile holds its buttons and says what
    // went; not the card's composable itself, whose report read would follow the attention list onto every page.
    const cleaning = useOperation<StorageCleanResult>(`sandbox/storage/clean`);
    const pressure = computed(() => (available.value ? query.data.value : undefined));
    const clean = async (): Promise<void> => {
        if (cleaning.busy.value) {
            return;
        }
        const label = storageCategoryLabel(`buildOutputs`);
        await cleaning.run({
            what: t(`sandbox.useSandboxStorage.cleaning`, { category: label }),
            tag: `buildOutputs`,
            failed: t(`sandbox.useSandboxStorage.couldntClean`, { category: label }),
            task: () => sandboxRpc.system.cleanStorage({ category: `buildOutputs` }, { context: { deadline: false } }),
        });
        await query.refetch();
    };
    return { pressure, cleaning: cleaning.busy, cleanNotice: cleaning.failure, clean };
}
