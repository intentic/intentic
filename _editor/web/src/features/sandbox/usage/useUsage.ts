import type { UsageRollupRow } from "@intentic/sandbox-contract/schemas/providers/usage";
import { mapLoaded } from "@intentic/extension-api";
import { computed } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";

// The active sandbox's spend ledger, rolled up by the daemon; read-only, rows append at turn end. Fetched whole and
// unbounded rather than windowed, since date presets and the previous-period delta each need ranges outside the
// selected window.

export function useUsage() {
    const { query, loaded } = useSandboxQuery(rpcQuery(`usage.rollup`, {}));

    return {
        rows: computed<readonly UsageRollupRow[]>(() => query.data.value?.rows ?? []),
        loaded: computed(() => mapLoaded(loaded.value, (answer) => answer.rows)),
        // Also fires on refetch, while the previous rows stay rendered.
        isFetching: query.isFetching,
        refetch: query.refetch,
    };
}
