import { type UsageRollupRow, UsageRollupSchema } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { sandboxJson } from "./sandboxClient";
import { sandboxKey } from "./useSandbox";
import { useSandboxQuery } from "./useSandboxQuery";

/* The active sandbox's spend ledger, rolled up by the daemon (usage/usage-store.ts) — the one read behind the
 * Usage tab. Read-only; rows are appended daemon-side at turn end.
 *
 * The WHOLE ledger comes down in one query, unbounded, and the browser windows it. The route takes from/to
 * bounds and this deliberately doesn't use them: every date preset would otherwise be a round trip, and the
 * "vs previous period" delta on each stat tile needs the window BEFORE the selected one, so a bounded fetch
 * would need two. Rolled rows are a handful per active day, so a year of hard use is well under a MB — cheaper
 * to hold than to re-fetch on every filter click.
 * ponytail: if a multi-year sandbox ever makes that payload matter, fetch `from` = the previous window's start
 * and drop All-time to a separate query — the bounds are already on the contract. */

const QUERY_KEY = sandboxKey(`usage-rollup`);

export function useUsage() {
    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async (): Promise<UsageRollupRow[]> => UsageRollupSchema.parse(await sandboxJson(`/usage/rollup`)).rows,
    });

    return {
        rows: computed<readonly UsageRollupRow[]>(() => query.data.value ?? []),
        // First load has nothing to show; a refetch keeps the previous render up (see the tab's dimming).
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        refetch: query.refetch,
        error,
    };
}
