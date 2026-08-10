import { queryClient } from "../queryPersistence";
import type { WarmBand, WarmTask } from "./warmPlan";

/* TURNING A CACHED READ INTO A WISH — the one shape every source here builds its list out of.
 *
 * Warming is not a second way to fetch. Every task below reads through the SAME query the screen it belongs to
 * reads through, so a warmed answer and a clicked one are one cache entry: the click either finds it sitting
 * there or joins the read already in flight (fetchQuery dedupes per key), and it can never be the case that the
 * app fetched a thing twice because one of the two callers was the loader.
 *
 * WHICH IS WHY A WISH IS DECLARED AS A QUERY, NOT AS A FUNCTION TO CALL. This took a `read` callback once, and
 * the two halves — "where it is filed" and "how to get it" — were passed separately and were free to disagree.
 * They did, for eight of the twelve wishes in the app: their read was the surface's plain fetcher, which returns
 * the body to its caller and files nothing, so the loader spent a round trip and the entry it had promised to
 * fill stayed empty. `have()` reads that entry, so it answered "no" forever, and since the loader always takes
 * the FIRST unsatisfied wish it re-read that one thing every beat and never reached anything behind it. Nearly
 * the whole plan — the rail included — was never warmed at all.
 *
 * Handing over the query itself makes that unsayable: the key the wish is satisfied by is the key the fetch
 * writes, because there is only one of them. The loader's own guard against a wish that still fails to settle
 * (backgroundLoader's STALL_RETRY_MS) is the second belt, for the shapes this can't reach — an extension's. */

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

/* ONE CACHED READ, as the query that defines it. The caching terms are optional and are the owning surface's to
 * set — a diff is immutable until something invalidates it (staleTime Infinity), a roster is not — so a wish
 * carries whatever its surface already decided rather than a second opinion held here. */
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
    // No retry, ever, and not negotiable per wish: a read-ahead that multiplies its own requests against a
    // daemon that is having a moment is the burst the loader's whole pacing exists to prevent. A failure leaves
    // nothing cached, so the click that follows asks again for real and reports what went wrong where the user
    // can act on it.
    read: () => queryClient.fetchQuery({ ...query, queryKey: [...query.queryKey], retry: false }),
});
