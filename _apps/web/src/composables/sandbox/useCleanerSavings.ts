import { type CleanerSavings, CleanerSavingsSchema } from "@intentic-app/api-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "./sandboxClient";
import { sandboxKey, useSandbox } from "./useSandbox";

/* The active sandbox's output-cleaner savings report (the rtk-`gain` surface), read from the daemon's
 * /settings/savings route — token savings + per-cleaner attribution + holdout-measured delta + un-cleaned gaps,
 * aggregated from the live filter-stats ledger. Read-only; refetched on focus so the card reflects recent turns. */

const QUERY_KEY = sandboxKey(`settings-savings`);

export function useCleanerSavings() {
    const { reachable } = useSandbox();

    const query = useQuery({
        queryKey: QUERY_KEY,
        queryFn: async (): Promise<CleanerSavings> => CleanerSavingsSchema.parse(await sandboxJson(`/settings/savings`)),
        enabled: reachable,
    });

    return {
        savings: computed<CleanerSavings | undefined>(() => query.data.value),
        isLoading: query.isLoading,
        refetch: query.refetch,
    };
}
