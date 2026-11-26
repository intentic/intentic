import type { HostedPlanState } from "@intentic/api-contract";
import { HOSTED_TIERS } from "@intentic/constants";
import { useLoaded } from "@intentic/extension-api";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { HOSTED_PLAN } from "../../lib/queryKeys";
import { apiClient } from "../../lib/useApi";
import { planBadge } from "./hostedHours";
import { planMoving } from "./planMoves";
import { useAccount } from "../../client/auth/useAccount";

// How often the plan is read while a machine restarts onto a new plan: its steps take seconds to a few minutes each.
const MOVING_EVERY_MS = 3_000;

// The hosted plan's state, read once for the whole app: Billing, the account badge, a hosted sandbox's hours on its own
// pages and in the chat strip, and whether the platform sells a plan at all. Account-scoped, not sandbox-scoped: a
// sandbox's hours are found in it by id (hostedHours.ts). A planless platform answers `enabled: false` rather than
// erroring.
export function useHostedPlan() {
    const { user } = useAccount();
    const query = useQuery({
        queryKey: HOSTED_PLAN.every,
        queryFn: (): Promise<HostedPlanState> => apiClient.hostedPlan.state(),
        enabled: computed(() => user.value !== null),
        staleTime: 60_000,
        refetchOnWindowFocus: true,
        // A machine restarting onto a bigger plan is watched every few seconds until it is done, and then no more.
        refetchInterval: (read) => (planMoving(read.state.data, Date.now()) ? MOVING_EVERY_MS : false),
        retry: 1,
    });

    const state = computed<HostedPlanState | undefined>(() => query.data.value);

    // Every write answers the whole plan, which goes straight into the cache every page draws from: the writes are awaited
    // by operations (operations.ts) that outlive the page that started them, so no observer of this caller's is assumed.
    const client = useQueryClient();
    const settle = (next: HostedPlanState): HostedPlanState => {
        client.setQueryData(HOSTED_PLAN.every, next);
        return next;
    };

    /* PUTS ONE SANDBOX ON A PLAN (2026-11-26), for a subscriber or a comped account; a first purchase is a checkout. Up is
     * paid now and its machine restarts in the background (the query then watches it, above); down waits for the renewal
     * date; its own plan withdraws a change still waiting; a due change's plan again tries a failed resize once more. */
    const changePlan = async (sandboxId: string, tier: string): Promise<HostedPlanState> => settle(await apiClient.hostedPlan.changePlan({ sandboxId, tier }));
    /** A plan for a sandbox about to be made at `tier`: an open one there, else one added for the rest of the month. */
    const reserve = async (tier: string): Promise<HostedPlanState> => settle(await apiClient.hostedPlan.reserve({ tier }));
    /** Ends one plan no sandbox is on, at the renewal date. */
    const release = async (tier: string): Promise<HostedPlanState> => settle(await apiClient.hostedPlan.release({ tier }));

    return {
        state,
        offered: computed(() => state.value?.enabled === true),
        onPlan: computed(() => state.value?.onPlan === true),
        priceUsd: computed(() => state.value?.priceUsd ?? 0),
        hosted: computed(() => state.value?.hosted),
        planBadge: computed(() => planBadge(state.value)),
        changePlan,
        reserve,
        release,
        // Every rung there is, so the page can price the ladder without a second read.
        tiers: HOSTED_TIERS,
        isLoading: query.isLoading,
        // What Billing draws the plan from (<Await :of>), its failure in words.
        loaded: useLoaded(() => ({
            data: query.data.value,
            error: query.error.value === null ? undefined : messageOr(query.error.value, t(`settings.settingsBilling.couldntLoadPlan`)),
            fetching: query.isFetching.value,
            wanted: true,
            retry: () => void query.refetch(),
        })),
        refetch: query.refetch,
    };
}

// Whether the account was ever on the plan: a lapsed subscription leaves `status` set while `onPlan` is false, the one
// trace a never-subscriber lacks.
export const hasReturned = (state: HostedPlanState | undefined): boolean => state?.onPlan === false && state.status !== undefined;
