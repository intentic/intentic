import { type DayWindowQuery, type SavingsReport, SavingsReportSchema } from "@intentic/sandbox-contract";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { SANDBOX_SAVINGS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

/* What each of this sandbox's token-reduction mechanisms was worth, from the daemon's /settings/savings route. */

export function useSavings(window: MaybeRefOrGetter<DayWindowQuery>) {
    const { query, error } = useSandboxQuery({
        queryKey: computed(() => SANDBOX_SAVINGS.of(toValue(window).from ?? `all`, toValue(window).to)),
        queryFn: async (): Promise<SavingsReport> => {
            const { from, to } = toValue(window);
            const params = new URLSearchParams({ ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
            return SavingsReportSchema.parse(await sandboxJson(`/settings/savings?${params.toString()}`));
        },
    });

    return {
        savings: computed<SavingsReport | undefined>(() => query.data.value),
        isLoading: query.isLoading,
        refetch: query.refetch,
        error,
    };
}
