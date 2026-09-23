import type { UsageRollupRow } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { rpcQuery } from "../client/rpcQuery";
import { useSandboxQuery } from "../client/useSandboxQuery";

// The active sandbox's spend ledger, rolled up by the daemon; read-only, rows append at turn end. Fetched whole and
// unbounded rather than windowed, since date presets and the previous-period delta each need ranges outside the
// selected window.

export function useUsage() {
    const { query, error } = useSandboxQuery(rpcQuery(`usage.rollup`, {}));

    return {
        rows: computed<readonly UsageRollupRow[]>(() => query.data.value?.rows ?? []),
        // True only on first load; isFetching also fires on refetch, while the previous rows stay rendered.
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        refetch: query.refetch,
        error,
    };
}
