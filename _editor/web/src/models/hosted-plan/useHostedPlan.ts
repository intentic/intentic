import type { HostedMigration, HostedPlanState } from "@intentic/api-contract";
import { HOSTED_TIERS } from "@intentic/constants";
import { useLoaded } from "@intentic/extension-api";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { HOSTED_PLAN } from "../../lib/queryKeys";
import { apiClient } from "../../lib/useApi";
import { planBadge } from "./hostedHours";

// The hosted plan's state, read once for the whole app: Billing, the account badge, a hosted sandbox's hours on its own
// pages and in the chat strip, and whether the platform sells a plan at all. Account-scoped, not sandbox-scoped: a
// sandbox's hours are found in it by id (hostedHours.ts). A planless platform answers `enabled: false` rather than
// erroring.
export function useHostedPlan() {
    const query = useQuery({
        queryKey: HOSTED_PLAN.every,
        queryFn: (): Promise<HostedPlanState> => apiClient.hostedPlan.state(),
        staleTime: 60_000,
        refetchOnWindowFocus: true,
        retry: 1,
    });

    const state = computed<HostedPlanState | undefined>(() => query.data.value);

    // The plan re-read through the cache rather than this caller's observer: the writes below are awaited by Billing's
    // operations (operations.ts), which outlive the page that started them.
    const client = useQueryClient();
    const reread = (): Promise<void> => client.invalidateQueries({ queryKey: HOSTED_PLAN.every });

    // Writes to Stripe then re-reads; one at a time is the caller's to keep, so racing presses can't overwrite each other.
    const setSlots = async (tier: string, quantity: number): Promise<void> => {
        await apiClient.hostedPlan.setSlots({ tier, quantity });
        await reread();
    };

    /* MOVES ONE SANDBOX ONTO A SLOT AT ANOTHER RUNG, which is a different act from buying the slot: the machine is
     * restarted on the new shape (or rebuilt beside itself and swapped), and one request answers once that is over. */
    const changeTier = async (sandboxId: string, tier: string): Promise<HostedMigration> => {
        const migration = await apiClient.hostedPlan.changeTier({ sandboxId, tier });
        await reread();
        return migration;
    };

    return {
        state,
        offered: computed(() => state.value?.enabled === true),
        onPlan: computed(() => state.value?.onPlan === true),
        priceUsd: computed(() => state.value?.priceUsd ?? 0),
        hosted: computed(() => state.value?.hosted),
        planBadge: computed(() => planBadge(state.value)),
        setSlots,
        changeTier,
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

// Button label read right before the decision; "Resubscribe" for someone who has been on the plan before.
export const subscribeLabel = (state: HostedPlanState | undefined, returning: boolean): string =>
    returning
        ? t(`settings.hostedPlanOffer.resubscribe`, { price: state?.priceUsd ?? 0 })
        : t(`settings.hostedPlanOffer.subscribe`, { price: state?.priceUsd ?? 0 });

// Whether the account was ever on the plan: a lapsed subscription leaves `status` set while `onPlan` is false, the one
// trace a never-subscriber lacks.
export const hasReturned = (state: HostedPlanState | undefined): boolean => state?.onPlan === false && state.status !== undefined;
