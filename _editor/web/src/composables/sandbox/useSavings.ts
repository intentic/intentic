import { type DayWindowQuery, type SavingsReport, SavingsReportSchema } from "@intentic/sandbox-contract";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { sandboxJson } from "./sandboxClient";
import { sandboxKey } from "./useSandbox";
import { useSandboxQuery } from "./useSandboxQuery";

/* What each of this sandbox's token-reduction mechanisms was worth, from the daemon's /settings/savings route:
 * the cleaners' realized per-command savings (exact) and the terse steer's measured A/B (an experiment, with a
 * sample size). Read-only; refetched on focus so the surfaces reflect recent turns.
 *
 * WINDOWED SERVER-SIDE, unlike useUsage — which fetches the whole rolled-up ledger once and lets the browser
 * slice it. The difference is the shape of what's behind them: the spend rollup is a handful of rows per active
 * day, while this one is aggregated from a row per Bash COMMAND and a row per turn, so the equivalent payload
 * would be the raw ledgers themselves. The window is in the query key, so a range change refetches.
 */

export function useSavings(window: MaybeRefOrGetter<DayWindowQuery>) {
    const { query, error } = useSandboxQuery({
        queryKey: computed(() => sandboxKey(`settings-savings`, toValue(window).from ?? `all`, toValue(window).to)),
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
