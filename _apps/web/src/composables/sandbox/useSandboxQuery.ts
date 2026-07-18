import { useQuery, type UseQueryOptions } from "@tanstack/vue-query";
import { computed, toValue } from "vue";
import { useSandbox } from "./useSandbox";

/* A daemon-backed vue-query: every direct sandbox read is gated on the ACTIVE daemon being reachable (the
 * liveness probe's verdict — see useSandbox), and a failure surfaces as the user-facing message the daemon
 * threw. Callers derive their own data computeds and reach the rest of vue-query's surface through `query`. */

const { reachable } = useSandbox();

export function useSandboxQuery<T>(options: UseQueryOptions<T>) {
    const query = useQuery<T>({ ...toValue(options), enabled: reachable });
    return { query, error: computed(() => query.error.value?.message) };
}
