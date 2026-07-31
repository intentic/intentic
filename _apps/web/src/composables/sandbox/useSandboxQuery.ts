import { useQuery, type QueryFunction, type UseQueryOptions } from "@tanstack/vue-query";
import { computed, toValue } from "vue";
import { useSandbox } from "./useSandbox";
import { trackPerf } from "../perf";

/* A daemon-backed vue-query: every direct sandbox read is gated on the ACTIVE daemon being reachable (the
 * liveness probe's verdict — see useSandbox), and a failure surfaces as the user-facing message the daemon
 * threw. Callers derive their own data computeds and reach the rest of vue-query's surface through `query`. */

const { reachable } = useSandbox();

export function useSandboxQuery<T>(options: UseQueryOptions<T>) {
    const resolved = toValue(options);
    /* Every daemon-backed read is timed HERE rather than at each call site, so no query can be added without
     * one — the fan-out that makes the review panel expensive is invisible precisely when someone adds the
     * query that causes it.
     *
     * This span is wider than `rpc.request`: it covers the queryFn's own work (parsing a six-figure change
     * list, deriving computeds) on top of the round-trip. The gap between the two is vue-query's and the
     * parser's, and a query that is slow with a fast request inside it is a client-side problem.
     *
     * `queryKey` is the op's field, not part of the op name: one row per key would fragment the table across
     * every file path and repo id the app has ever read. */
    const key = String(toValue(resolved.queryKey)?.[0] ?? `unknown`);
    // Only a real function is wrapped: vue-query also accepts `skipToken` here, which is a sentinel meaning
    // "don't run", and timing that would both break the sentinel and measure nothing.
    const fetcher = resolved.queryFn;
    const query = useQuery<T>({
        ...resolved,
        ...(typeof fetcher === `function`
            ? { queryFn: ((context) => trackPerf(`query.fetch`, { key }, async () => fetcher(context))) satisfies QueryFunction<T> }
            : {}),
        enabled: reachable,
    });
    return { query, error: computed(() => query.error.value?.message) };
}
