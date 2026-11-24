import type { ReceivedDrop } from "@intentic/sandbox-contract/schemas/account-routes";
import { computed, type ComputedRef } from "vue";
import { sandboxRaw } from "../../../../client/sandbox/sandboxRaw";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { useTier } from "../../../../client/sandbox/useTier";
import { RECEIVED_DROPS } from "../../../../lib/queryKeys";

// The drops waiting in this sandbox's inbox for the reader (docs/architecture/account-routing.md): another sandbox they
// are in sent a note and files as them, starting nothing here. The daemon cuts the list to the drops naming the reader,
// or every one for a maintainer, so this only reads it. No push says a drop arrived, so it is read again every minute.
// A guest is never named by a drop (a drop needs collaborator access), and a daemon from before drops serves no inbox.

const REFRESH_MS = 60_000;

export const useReceivedDrops = () => {
    const { isGuest } = useTier();
    const { query } = useSandboxQuery({
        queryKey: RECEIVED_DROPS.of(),
        queryFn: async () => (await sandboxRaw(`GET /account/inbox`)).drops,
        enabled: computed(() => !isGuest.value && supportsRoute(`GET /account/inbox`)),
        refetchInterval: REFRESH_MS,
    });
    const drops: ComputedRef<readonly ReceivedDrop[]> = computed(() => query.data.value ?? []);
    const refresh = async (): Promise<void> => {
        await query.refetch();
    };
    return { drops, refresh };
};
