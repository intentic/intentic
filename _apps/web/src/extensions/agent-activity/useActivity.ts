import { type ActivityEvent, ActivityListSchema, type ActivityStatus, ActivityStatusSchema } from "@intentic-app/api-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../../composables/sandboxClient";
import { sandboxKey, useSandbox } from "../../composables/useSandbox";

/* The agent-activity audit feed, via the daemon's /activity routes: the durable event log (inbound wakes,
 * sniffed outbound provider calls, voice sessions, failures) plus the live connection/voice status probe.
 * Plain polling — an audit feed doesn't need sub-second freshness. */

const POLL_MS = 5000;
const FEED_LIMIT = 200;

export function useActivity() {
    const { reachable } = useSandbox();

    const feed = useQuery({
        queryKey: sandboxKey(`activity`),
        queryFn: async () => ActivityListSchema.parse(await sandboxJson(`/activity?limit=${FEED_LIMIT}`)).events,
        enabled: reachable,
        refetchInterval: POLL_MS,
    });
    const status = useQuery({
        queryKey: sandboxKey(`activity-status`),
        queryFn: async () => ActivityStatusSchema.parse(await sandboxJson(`/activity/status`)),
        enabled: reachable,
        refetchInterval: POLL_MS,
    });

    return {
        events: computed<ActivityEvent[]>(() => feed.data.value ?? []),
        status: computed<ActivityStatus | undefined>(() => status.data.value),
        error: computed(() => feed.error.value?.message ?? status.error.value?.message),
        isLoading: computed(() => feed.isLoading.value || status.isLoading.value),
    };
}
