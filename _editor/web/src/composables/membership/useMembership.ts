import type { MembershipState } from "@intentic-app/api-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { MEMBERSHIP } from "../queryKeys";
import { apiClient } from "../useApi";
import { creditMeter } from "./creditMeter";

/* THE MEMBERSHIP AND ITS CREDIT METER, read once for the whole app.
 *
 * Credits used to be fetched ad-hoc by the two surfaces that wanted them, which is why they appeared in exactly
 * one place: any third surface would have had to add a third round-trip and its own copy of the arithmetic. Now
 * the account menu, the premium install dialog, the chat composer and the membership card all observe ONE cache
 * entry, so they cannot disagree about what is left — and a spend made on one of them moves all four.
 *
 * NOT SANDBOX-SCOPED (see MEMBERSHIP in queryKeys.ts): the allowance belongs to the signed-in person and is
 * spent by every sandbox they own.
 *
 * WHY IT REFETCHES ON A TIMER, quietly, and why that is not the metering the membership page promises isn't
 * happening. Credits leave in two ways and only one of them passes through this browser: an install is a button
 * here (and calls `spent()` the moment it lands), while a premium SERVICE run is spent by the agent inside the
 * sandbox, with nothing for the browser to hook. Without a periodic read the composer's pill would sit on a
 * pre-run figure for as long as the tab stayed open — a stale number being strictly worse than none. The read is
 * a few hundred bytes, it only runs where the platform sells a membership, and it counts nothing: the platform
 * already knows what it spent, and this asks it what that came to. */

// Long enough that a tab left open all afternoon is not chatty, short enough that a service run the agent
// completed a minute ago is reflected before anyone goes looking for why the number is wrong.
const REFETCH_MS = 60_000;

export function useMembership() {
    const client = useQueryClient();

    const query = useQuery({
        queryKey: MEMBERSHIP.every,
        queryFn: (): Promise<MembershipState> => apiClient.pool.membership(),
        // The allowance moves on the platform's clock, not this tab's — a read from a minute ago is a fine
        // answer to "how much is left", and treating it as fresh keeps four surfaces mounting on one fetch.
        staleTime: REFETCH_MS,
        refetchInterval: REFETCH_MS,
        refetchOnWindowFocus: true,
        // A platform with no pool answers this route with `enabled: false` rather than an error, so there is
        // nothing to retry hard for; a transient failure simply leaves every credit surface absent.
        retry: 1,
    });

    const state = computed<MembershipState | undefined>(() => query.data.value);

    return {
        state,
        offered: computed(() => state.value?.enabled === true),
        member: computed(() => state.value?.member === true),
        meter: computed(() => creditMeter(state.value)),
        donationCredits: computed(() => state.value?.donationCredits ?? 0),
        dailyCredits: computed(() => state.value?.dailyCredits ?? 0),
        isLoading: query.isLoading,
        error: query.error,
        /** Re-read the meter now — what a surface calls the moment it has spent something. */
        spent: async (): Promise<void> => {
            await client.invalidateQueries({ queryKey: MEMBERSHIP.every });
        },
        refetch: query.refetch,
    };
}
