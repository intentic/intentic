import { useQuery, type QueryFunction, type UseQueryOptions } from "@tanstack/vue-query";
import { useLoaded } from "@intentic/extension-api";
import { computed, type MaybeRefOrGetter, shallowRef, toValue, watch } from "vue";
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
    // The query's last failure, kept through a try it makes by itself afterwards. vue-query clears `error` the moment a
    // query with no answer starts fetching again (an interval, a push, a refocus), which drew every such try as a fresh
    // wait over the failure; `useLoaded` keeps the failure on screen unless the person asked for the retry. Tied to the
    // failure's own moment (`errorUpdatedAt`, which that reset leaves alone and which is the current key's), so a new key
    // or a later answer never inherits it.
    const lastFailure = shallowRef<{ readonly at: number; readonly words: string }>();
    watch(
        [error, query.errorUpdatedAt],
        ([words, at]) => {
            if (words !== undefined) {
                lastFailure.value = { at, words };
            }
        },
        { flush: `sync` },
    );
    const standingFailure = computed((): string | undefined => {
        if (error.value !== undefined || query.data.value !== undefined) {
            return error.value;
        }
        const last = lastFailure.value;
        return last !== undefined && last.at === query.errorUpdatedAt.value ? last.words : undefined;
    });
    // What the view draws from: wanted is the caller's own gate alone, so a read held while the sandbox wakes is a wait,
    // never an empty answer, and one the view has not asked for yet is never a wait. Joined to the <Await> region it is
    // read in, which keeps that region's remembered look until it has answered.
    const loaded = useLoaded<Selected>(() => ({
        data: query.data.value,
        error: standingFailure.value,
        fetching: query.isFetching.value,
        wanted: resolved.enabled === undefined || toValue(resolved.enabled) !== false,
        retry: () => void query.refetch(),
    }));
    return { query, error, loaded };
}
