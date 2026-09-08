import { useQuery, type QueryFunction, type UseQueryOptions } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { queryClient } from "../../../lib/queryPersistence";
import { useSandbox } from "./useSandbox";
import { trackPerf } from "../../../app/perf";

// Daemon-backed vue-query wrapper: every read gates on the active daemon being reachable, and a failure
// surfaces as the message the daemon threw.

const { reachable } = useSandbox();

// When `aimedAt` names another sandbox, the active daemon's reachability is irrelevant: the read is simply
// issued for that box. A ref/getter, since the aim can change under a mounted panel.
export function useSandboxQuery<T>(options: UseQueryOptions<T>, aimedAt?: MaybeRefOrGetter<string | undefined>) {
    const resolved = toValue(options);
    // Every daemon-backed read is timed here rather than at each call site, so none can skip it. `queryKey`'s first
    // element groups the table entry; the rest of the key varies per call and isn't part of the op name.
    const key = String(toValue(resolved.queryKey)?.[0] ?? `unknown`);
    // Only wrapped when it's a real function; vue-query also accepts `skipToken` here to mean "don't run".
    const fetcher = resolved.queryFn;
    const query = useQuery<T>(
        {
            ...resolved,
            ...(typeof fetcher === `function`
                ? { queryFn: ((context) => trackPerf(`query.fetch`, { key }, async () => fetcher(context))) satisfies QueryFunction<T> }
                : {}),
            // Reachability is an additional gate, not a replacement: a caller's own `enabled` (e.g. missing id) still
            // applies.
            enabled: computed(
                () =>
                    (toValue(aimedAt) !== undefined || toValue(reachable)) &&
                    (resolved.enabled === undefined || toValue(resolved.enabled) !== false),
            ),
        },
        // Passed explicitly rather than resolved via inject(), which needs a Vue setup context a read triggered from a
        // plain handler doesn't have.
        queryClient,
    );
    return { query, error: computed(() => query.error.value?.message) };
}
