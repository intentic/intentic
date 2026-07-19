import { type ActivityEvent, ActivityListSchema, type ActivityStatus, ActivityStatusSchema } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The activity audit feed, via the daemon's /activity routes: the durable event log (inbound wakes,
 * sniffed outbound provider calls, voice sessions, failures) plus the live connection/voice status probe.
 * Plain polling — an audit feed doesn't need sub-second freshness. All daemon access goes through the host api. */

const POLL_MS = 5000;
const FEED_LIMIT = 200;

export function useActivity() {
    const api = host();
    const enabled = computed(() => api.sandbox.reachable());

    const feed = useQuery({
        queryKey: api.sandbox.key(`activity`),
        queryFn: async () => ActivityListSchema.parse(await api.sandbox.json(`/activity?limit=${FEED_LIMIT}`)).events,
        enabled,
        refetchInterval: POLL_MS,
    });
    const status = useQuery({
        queryKey: api.sandbox.key(`activity-status`),
        queryFn: async () => ActivityStatusSchema.parse(await api.sandbox.json(`/activity/status`)),
        enabled,
        refetchInterval: POLL_MS,
    });

    return {
        events: computed<ActivityEvent[]>(() => feed.data.value ?? []),
        status: computed<ActivityStatus | undefined>(() => status.data.value),
        error: computed(() => feed.error.value?.message ?? status.error.value?.message),
        isLoading: computed(() => feed.isLoading.value || status.isLoading.value),
    };
}
