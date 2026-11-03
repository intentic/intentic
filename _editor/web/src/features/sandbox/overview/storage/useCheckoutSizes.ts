import type { CheckoutUsage } from "@intentic/sandbox-contract/schemas/metrics";
import { computed, type ComputedRef } from "vue";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { useRole } from "../../../../client/sandbox/useRole";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";

// The last scan's checkouts by conversation, for the board's cards: the same read the Disk card makes, never a scan.
// Kept a minute, since a board of fifty cards asks once and the figures only move when somebody scans again.
const KEPT_MS = 60_000;

export function useCheckoutSizes(): ComputedRef<ReadonlyMap<string, CheckoutUsage>> {
    const { canShip } = useRole();
    const available = computed(() => canShip.value && supportsRoute(`system.storage`));
    const read = rpcQuery(`system.storage`, undefined, { unpersisted: true });
    const { query } = useSandboxQuery({ ...read, enabled: available, staleTime: KEPT_MS });
    return computed(() => new Map((query.data.value?.checkouts ?? []).map((row) => [row.id, row])));
}
