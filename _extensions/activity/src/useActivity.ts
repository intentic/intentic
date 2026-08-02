import { type ActivityEvent, ActivityListSchema, type ActivityStatus, ActivityStatusSchema } from "@intentic/sandbox-contract";
import { useInfiniteQuery, useQuery } from "@tanstack/vue-query";
import { computed, type Ref, watch } from "vue";
import { host } from "./host";
import { sinceOf, type Window } from "./episodes";

/* The activity audit feed, via the daemon's /activity routes: the durable event log (inbound wakes, sniffed
 * outbound provider calls, turn lifecycle, failures) plus the live connection/voice status probe. Plain polling —
 * an audit feed doesn't need sub-second freshness. All daemon access goes through the host api.
 *
 * PAGED, because a fixed limit is a silent lie. The log is newest-first with an exclusive `at` cursor, so the
 * selected time window decides how much to pull rather than a constant chosen once: pick 7d and the feed keeps
 * fetching until the oldest event it holds is older than the window, which is the only way "last 7 days" can be
 * true. Bounded at MAX_PAGES so a wide window on a busy log cannot turn into an unbounded fetch loop — and when
 * that bound bites, `truncated` says so instead of letting a partial answer look complete. */

const POLL_MS = 5000;
// The contract's per-request ceiling (ActivityQuerySchema). Fewer, bigger pages beats more, smaller ones here:
// every page is a round trip and the rows are small.
const PAGE = 500;
// 4 × 500 = 2,000, which is exactly the store's own prune ceiling (activity-store.ts KEEP_LINES) — so this bound
// can only bite on a log that has grown past what the daemon keeps.
const MAX_PAGES = 4;

export function useActivity(window: Ref<Window>) {
    const api = host();
    const enabled = computed(() => api.sandbox.reachable());

    const feed = useInfiniteQuery({
        queryKey: api.sandbox.key(`activity`),
        queryFn: async ({ pageParam }) =>
            ActivityListSchema.parse(await api.sandbox.json(`/activity?limit=${PAGE}${pageParam === undefined ? `` : `&before=${pageParam}`}`))
                .events,
        initialPageParam: undefined as number | undefined,
        // The oldest event's `at` is the next exclusive cursor; a short page is the end of the log.
        getNextPageParam: (last: ActivityEvent[]) => (last.length < PAGE ? undefined : last.at(-1)?.at),
        enabled,
        /* A poll refetches EVERY page it holds, and every page but the first is immutable — the log only appends
         * at the head, so re-fetching history buys nothing and costs a request per page. Full cadence while the
         * feed is one page (the default 24h window, and the case where freshness is actually visible); backed off
         * once a wide window has pulled history in, where the point is the history rather than the last 5s. */
        refetchInterval: (query) => ((query.state.data?.pages.length ?? 1) > 1 ? POLL_MS * 6 : POLL_MS),
    });
    const status = useQuery({
        queryKey: api.sandbox.key(`activity-status`),
        queryFn: async () => ActivityStatusSchema.parse(await api.sandbox.json(`/activity/status`)),
        enabled,
        refetchInterval: POLL_MS,
    });

    const events = computed<ActivityEvent[]>(() => (feed.data.value?.pages ?? []).flat());
    const pages = computed(() => feed.data.value?.pages.length ?? 0);
    // Whether what we hold reaches back past the window's edge. False while a page is still missing, which is
    // what drives the pull below and what `truncated` reports when the page bound stops it.
    const covered = computed(() => {
        if (window.value === `all`) {
            return feed.hasNextPage.value !== true;
        }
        const oldest = events.value.at(-1);
        return oldest === undefined || oldest.at <= sinceOf(window.value, Date.now()) || feed.hasNextPage.value !== true;
    });

    // Widening the window pulls what it needs, one page per pass; narrowing costs nothing because the pages are
    // already cached. Cheap to re-enter — fetchNextPage is a no-op while a fetch is in flight.
    watch(
        [covered, pages, () => feed.isFetching.value],
        () => {
            if (!covered.value && pages.value < MAX_PAGES && !feed.isFetching.value) {
                void feed.fetchNextPage();
            }
        },
        { immediate: true },
    );

    return {
        events,
        status: computed<ActivityStatus | undefined>(() => status.data.value),
        error: computed(() => feed.error.value?.message ?? status.error.value?.message),
        isLoading: computed(() => feed.isLoading.value || status.isLoading.value),
        // The window asked for more than the page bound allows — the feed is showing a prefix, and says so.
        truncated: computed(() => !covered.value && pages.value >= MAX_PAGES),
        oldestAt: computed(() => events.value.at(-1)?.at),
    };
}
