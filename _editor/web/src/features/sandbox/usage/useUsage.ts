import { type UsageRollupRow, UsageRollupSchema } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { USAGE_ROLLUP } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// The active sandbox's spend ledger, rolled up by the daemon; read-only, rows append at turn end. Fetched whole and
// unbounded rather than windowed, since date presets and the previous-period delta each need ranges outside the
// selected window.

const QUERY_KEY = USAGE_ROLLUP.of();

export function useUsage() {
    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async (): Promise<UsageRollupRow[]> => UsageRollupSchema.parse(await sandboxJson(`/usage/rollup`)).rows,
    });

    return {
        rows: computed<readonly UsageRollupRow[]>(() => query.data.value ?? []),
        // True only on first load; isFetching also fires on refetch, while the previous rows stay rendered.
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        refetch: query.refetch,
        error,
    };
}
