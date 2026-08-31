import { useQuery, type QueryFunction, type UseQueryOptions } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { queryClient } from "../queryPersistence";
import { useSandbox } from "./useSandbox";
import { trackPerf } from "../perf";

/* A daemon-backed vue-query: every direct sandbox read is gated on the ACTIVE daemon being reachable (the
 * liveness probe's verdict, see useSandbox), and a failure surfaces as the user-facing message the daemon
 * threw. Callers derive their own data computeds and reach the rest of vue-query's surface through `query`. */

const { reachable } = useSandbox();

/* WHEN THE READ IS AIMED AT ANOTHER SANDBOX, the active daemon's reachability is not the question, and gating
 * on it is actively wrong: the review of an agent in box B would refuse to load because box A's stream happened
 * to be down, which is precisely the coupling the cross-sandbox surfaces exist to remove. There is no liveness
 * probe for a box this browser is not pointed at (there is one stream and it belongs to the active sandbox), so
 * such a read is simply issued: it answers, or it fails and the surface says which box did not answer.
 *
 * A ref rather than a boolean, because the aim can change under a mounted panel (the review's agent id and its
 * box both come from the route).
 */
export function useSandboxQuery<T>(options: UseQueryOptions<T>, aimedAt?: MaybeRefOrGetter<string | undefined>) {
    const resolved = toValue(options);
    /* Every daemon-backed read is timed HERE rather than at each call site, so no query can be added without
     * one, the fan-out that makes the review panel expensive is invisible precisely when someone adds the
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
    const query = useQuery<T>(
        {
            ...resolved,
            ...(typeof fetcher === `function`
                ? { queryFn: ((context) => trackPerf(`query.fetch`, { key }, async () => fetcher(context))) satisfies QueryFunction<T> }
                : {}),
            // Reachability is an ADDITIONAL gate, not a replacement: a caller may have its own reason not to run
            // yet (an id it doesn't have, a subject that isn't in scope on this screen), and overwriting that with
            // `reachable` alone turned every such caller into a request for a resource it knew wasn't there.
            enabled: computed(
                () =>
                    (toValue(aimedAt) !== undefined || toValue(reachable)) &&
                    (resolved.enabled === undefined || toValue(resolved.enabled) !== false),
            ),
        },
        /* THE APP'S ONE CLIENT, HANDED OVER RATHER THAN INJECTED. Left to itself vue-query resolves it with
         * `inject()`, which needs Vue's injection context, and a daemon read is not always reached from a
         * setup: a run button names its model from a computed, and an extension may ask for the same fact from
         * a click handler. Neither has a context, so the injected lookup THREW there (`vue-query hooks can only
         * be used inside setup()`), taking the whole surface down with it. There is exactly one QueryClient in
         * this app (main.ts installs this same object), so naming it here is the same client with none of the
         * ceremony, and no way for the ceremony to fail. */
        queryClient,
    );
    return { query, error: computed(() => query.error.value?.message) };
}
