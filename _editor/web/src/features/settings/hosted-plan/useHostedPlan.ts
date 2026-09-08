import type { HostedPlanState } from "@intentic/api-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { HOSTED_PLAN } from "../../../lib/queryKeys";
import { apiClient } from "../../../lib/useApi";
import { hoursMeter, lowOnHours, machineStandingLine, planBadge } from "./hostedHours";

// The hosted plan's state, read once for the whole app: Billing, the account badge, Overview, the chat strip, and
// whether the platform sells a plan at all. Not sandbox-scoped; a planless platform answers `enabled: false` rather
// than erroring.
export function useHostedPlan() {
    const query = useQuery({
        queryKey: HOSTED_PLAN.every,
        queryFn: (): Promise<HostedPlanState> => apiClient.hostedPlan.state(),
        staleTime: 60_000,
        refetchOnWindowFocus: true,
        retry: 1,
    });

    const state = computed<HostedPlanState | undefined>(() => query.data.value);
    const meter = computed(() => hoursMeter(state.value?.hosted?.usage));

    // Writes to Stripe then refetches; one in-flight call at a time so racing presses can't overwrite each other.
    const slotsWorking = ref(false);
    const setSlots = async (quantity: number): Promise<void> => {
        if (slotsWorking.value) {
            return;
        }
        slotsWorking.value = true;
        try {
            await apiClient.hostedPlan.setSlots({ quantity });
            await query.refetch();
        } finally {
            slotsWorking.value = false;
        }
    };

    return {
        state,
        offered: computed(() => state.value?.enabled === true),
        onPlan: computed(() => state.value?.onPlan === true),
        priceUsd: computed(() => state.value?.priceUsd ?? 0),
        hosted: computed(() => state.value?.hosted),
        // Free lane usage meter; undefined where it doesn't apply.
        meter,
        lowOnHours: computed(() => lowOnHours(meter.value)),
        planBadge: computed(() => planBadge(state.value)),
        machineStanding: computed(() => machineStandingLine(state.value)),
        setSlots,
        slotsWorking,
        isLoading: query.isLoading,
        error: query.error,
        refetch: query.refetch,
    };
}

// Button label read right before the decision; "Resubscribe" for someone who has been on the plan before.
export const subscribeLabel = (state: HostedPlanState | undefined, returning: boolean): string =>
    `${returning ? `Resubscribe` : `Subscribe`} for $${state?.priceUsd ?? 0}/month`;

// Whether the account was ever on the plan: a lapsed subscription leaves `status` set while `onPlan` is false, the one
// trace a never-subscriber lacks.
export const hasReturned = (state: HostedPlanState | undefined): boolean => state?.onPlan === false && state.status !== undefined;
