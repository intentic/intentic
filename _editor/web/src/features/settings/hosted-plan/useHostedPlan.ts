import type { HostedPlanState } from "@intentic/api-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { HOSTED_PLAN } from "../../../lib/queryKeys";
import { apiClient } from "../../../lib/useApi";

/* THE HOSTED PLAN, read once for the whole app: the settings tab's state, and whether the platform sells one
 * at all (a self-hosted platform does not, and every surface that mentions the plan is absent there).
 *
 * NOT SANDBOX-SCOPED (see HOSTED_PLAN in queryKeys.ts): the plan belongs to the signed-in person, and it is
 * their hosted sandbox it keeps always on. A platform with no plan answers this route with `enabled: false`
 * rather than an error, so there is nothing to retry hard for. */
export function useHostedPlan() {
    const query = useQuery({
        queryKey: HOSTED_PLAN.every,
        queryFn: (): Promise<HostedPlanState> => apiClient.hostedPlan.state(),
        staleTime: 60_000,
        refetchOnWindowFocus: true,
        retry: 1,
    });

    const state = computed<HostedPlanState | undefined>(() => query.data.value);

    return {
        state,
        offered: computed(() => state.value?.enabled === true),
        onPlan: computed(() => state.value?.onPlan === true),
        priceUsd: computed(() => state.value?.priceUsd ?? 0),
        isLoading: query.isLoading,
        error: query.error,
        refetch: query.refetch,
    };
}

/* THE BUY BUTTON'S OWN NAME. The button is the last thing read before a decision, so it says which decision
 * this is: "Resubscribe" for somebody who has been on the plan before. */
export const subscribeLabel = (state: HostedPlanState | undefined, returning: boolean): string =>
    `${returning ? `Resubscribe` : `Subscribe`} for $${state?.priceUsd ?? 0}/month`;

/* Whether this account has been on the plan before. A lapsed or cancelled plan leaves a `status` behind while
 * `onPlan` is false, the same shape a never-subscriber has, minus that trace. */
export const hasReturned = (state: HostedPlanState | undefined): boolean => state?.onPlan === false && state.status !== undefined;
