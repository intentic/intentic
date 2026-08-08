import { queryClient } from "../queryPersistence";
import type { WarmBand, WarmTask } from "./warmPlan";

/* TURNING A CACHED READ INTO A WISH — the one shape every source here builds its list out of.
 *
 * Warming is not a second way to fetch. Every task below reads through the SAME query the screen it belongs to
 * reads through, so a warmed answer and a clicked one are one cache entry: the click either finds it sitting
 * there or joins the read already in flight (fetchQuery dedupes per key), and it can never be the case that the
 * app fetched a thing twice because one of the two callers was the loader. */

/* IS IT IN HAND? Data present AND not invalidated — both halves matter.
 *
 * Present alone is not enough, because an invalidation is exactly how this app says "that answer describes a
 * moment that has passed": a commit, an agent landing work, a turn ending. A warmer that treated invalidated
 * data as satisfied would go quiet at precisely the moment the screen behind it went stale, and the click would
 * pay the refetch — which is the whole cost this exists to remove. Treating it as missing instead means the
 * loader picks it up on its very next beat, without anything having to tell the loader it should. */
export const heldInCache = (queryKey: readonly unknown[]): boolean => {
    const state = queryClient.getQueryState([...queryKey]);
    return state?.data !== undefined && !state.isInvalidated;
};

/** A wish for one cached read: warm it through `read`, and consider it satisfied when its key holds data. */
export const warmQuery = (key: string, band: WarmBand, queryKey: readonly unknown[], read: () => Promise<unknown>): WarmTask => ({
    key,
    band,
    have: () => heldInCache(queryKey),
    read,
});
