import { queryClient } from "../../lib/queryPersistence";
import type { WarmBand, WarmTask } from "./warmPlan";

// Turns a cached read into a wish: every task reads through the same query the screen uses, so a warmed
// answer and a clicked one are one cache entry (fetchQuery dedupes per key). A wish is declared as a
// query, not a callback, so the key it's satisfied by is necessarily the key its fetch writes.

// In hand only if data is present and not invalidated; invalidated data must count as missing, or the
// loader would go quiet exactly when the screen behind it goes stale.
export const heldInCache = (queryKey: readonly unknown[]): boolean => {
    const state = queryClient.getQueryState([...queryKey]);
    return state?.data !== undefined && !state.isInvalidated;
};

// One cached read, as the query that defines it. Caching terms (staleTime, gcTime) are optional and
// belong to the owning surface; a wish carries whatever it already decided.
export interface WarmSpec {
    readonly queryKey: readonly unknown[];
    readonly queryFn: () => Promise<unknown>;
    readonly staleTime?: number;
    readonly gcTime?: number;
}

/** A wish for one cached read: fetch it into its own key, and consider it satisfied when that key holds data. */
export const warmQuery = (key: string, band: WarmBand, query: WarmSpec): WarmTask => ({
    key,
    band,
    have: () => heldInCache(query.queryKey),
    // No retry: a failed warm leaves nothing cached, so the next click retries for real and can surface the error.
    read: () => queryClient.fetchQuery({ ...query, queryKey: [...query.queryKey], retry: false }),
});
