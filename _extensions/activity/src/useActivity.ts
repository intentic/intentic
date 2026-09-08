import { type ActivityEvent, ActivityListSchema, type ActivityStatus, ActivityStatusSchema } from "@intentic/sandbox-contract";
import { useInfiniteQuery, useQuery } from "@tanstack/vue-query";
import { computed, type Ref, watch } from "vue";
import { sinceOf, type TimeWindow } from "@intentic/extension-ui";
import { host } from "./host";

// The activity feed: the daemon's durable event log (wakes, outbound calls, turn lifecycle, failures) plus live
// connection/voice status, polled. Paged, since a fixed limit would silently lie: the window decides how far back to
// pull. Bounded at MAX_PAGES; `truncated` says when that bound bit.

const POLL_MS = 5000;
// Contract's per-request ceiling (ActivityQuerySchema); fewer, bigger pages beat many small round trips.
const PAGE = 500;
// 4×500 = 2,000, matching the daemon's prune ceiling (activity-store.ts KEEP_LINES); only bites past that.
const MAX_PAGES = 4;

export function useActivity(window: Ref<TimeWindow>) {
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
        // A poll refetches every held page, but only the newest can have changed; full cadence with one page, backed
        // off once history is pulled in for its own sake.
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
    // Whether history reaches the window's edge; false drives the pull below and, if capped, `truncated`.
    const covered = computed(() => {
        if (window.value === `all`) {
            return feed.hasNextPage.value !== true;
        }
        const oldest = events.value.at(-1);
        return oldest === undefined || oldest.at <= sinceOf(window.value, Date.now()) || feed.hasNextPage.value !== true;
    });

    // Widens by pulling one page per pass; narrowing is free since pages stay cached. Re-entrant: fetchNextPage no-ops
    // mid-flight.
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
        // True when the window needs more than the page bound allows; the feed is a prefix, and says so.
        truncated: computed(() => !covered.value && pages.value >= MAX_PAGES),
        oldestAt: computed(() => events.value.at(-1)?.at),
    };
}
