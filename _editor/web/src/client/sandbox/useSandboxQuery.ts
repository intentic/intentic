import { useQuery, type QueryFunction, type UseQueryOptions } from "@tanstack/vue-query";
import { useLoaded } from "@intentic/extension-api";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { queryClient } from "../../lib/queryPersistence";
import { readFailure } from "./useDaemonRoutes";
import { useSandbox } from "./useSandbox";
import { trackPerf } from "../../app/perf/perf";

// Daemon-backed vue-query wrapper: every read gates on the active daemon being reachable, a failure surfaces as the
// message the daemon threw, and `loaded` says what the view has of it (@intentic/extension-api's `Loaded`).

const { reachable } = useSandbox();

// When `aimedAt` names another sandbox, the active daemon's reachability is irrelevant: the read is simply
// issued for that box. A ref/getter, since the aim can change under a mounted panel.
// `select` narrows what the cache holds to what a reader wants (a count out of a list): the entry stays the procedure's
// own, shared with every other reader of it, and only this reader's `data` is the narrowed one.
export function useSandboxQuery<T, Selected = T>(options: UseQueryOptions<T, Error, Selected>, aimedAt?: MaybeRefOrGetter<string | undefined>) {
    const resolved = toValue(options);
    // Every daemon-backed read is timed here rather than at each call site, so none can skip it. `queryKey`'s first
    // element groups the table entry; the rest of the key varies per call and isn't part of the op name.
    const key = String(toValue(resolved.queryKey)?.[0] ?? `unknown`);
    // Only wrapped when it's a real function; vue-query also accepts `skipToken` here to mean "don't run".
    const fetcher = resolved.queryFn;
    const query = useQuery<T, Error, Selected>(
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
    const error = computed(() => (query.error.value === null ? undefined : readFailure(query.error.value)));
    // What the view draws from: wanted is the caller's own gate alone, so a read held while the sandbox wakes is a wait,
    // never an empty answer, and one the view has not asked for yet is never a wait. Joined to the <Await> region it is
    // read in, which keeps that region's remembered look until it has answered.
    const loaded = useLoaded<Selected>(() => ({
        data: query.data.value,
        error: error.value,
        fetching: query.isFetching.value,
        wanted: resolved.enabled === undefined || toValue(resolved.enabled) !== false,
        retry: () => void query.refetch(),
    }));
    return { query, error, loaded };
}
