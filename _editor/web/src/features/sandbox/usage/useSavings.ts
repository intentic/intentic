import type { DayWindowQuery, SavingsReport } from "@intentic/sandbox-contract";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { rpcQuery } from "../client/rpcQuery";
import { useSandboxQuery } from "../client/useSandboxQuery";

/* What each of this sandbox's token-reduction mechanisms was worth, from the daemon's savings read over one window. */

export function useSavings(window: MaybeRefOrGetter<DayWindowQuery>) {
    const { query, error } = useSandboxQuery(rpcQuery(`settings.savings`, () => toValue(window)));

    return {
        savings: computed<SavingsReport | undefined>(() => query.data.value),
        isLoading: query.isLoading,
        refetch: query.refetch,
        error,
    };
}
