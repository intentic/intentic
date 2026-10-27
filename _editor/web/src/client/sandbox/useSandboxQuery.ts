import { useQuery, type QueryFunction, type UseQueryOptions } from "@tanstack/vue-query";
import { useLoaded } from "@intentic/extension-api";
import { computed, type MaybeRefOrGetter, shallowRef, toValue, watch } from "vue";
import { queryClient } from "../../lib/queryPersistence";
import { reportQueryFreshness } from "./freshness/queryFreshness";
import { readFailure } from "./useDaemonRoutes";
import { useSandbox } from "./useSandbox";
import { trackPerf } from "../../app/perf/perf";
import { type AccessReason, accessReasonOf } from "./access/accessReason";

// Daemon-backed vue-query wrapper: every read gates on the active daemon being reachable, a failure surfaces as the
// message the daemon threw, and `loaded` says what the view has of it (@intentic/extension-api's `Loaded`). A read the
// person's access refuses is not a failure: it surfaces as `locked`, with why, and never as `error`, and `loaded` reads
// it as a read not asked for, so no view draws "couldn't load" for something that was never theirs to load.

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
    // Why the person may not read this, when that is why it has no answer (access/accessReason.ts).
    const locked = computed<AccessReason | undefined>(() => accessReasonOf(query.error.value));
    const error = computed(() => (query.error.value === null || locked.value !== undefined ? undefined : readFailure(query.error.value)));
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
    // A locked read draws nothing it held from before the person lost access to it, and no wait for a try it makes
    // again by itself (an interval, a push), which the access check answers at once.
    const loaded = useLoaded<Selected>(() => ({
        data: locked.value === undefined ? query.data.value : undefined,
        error: standingFailure.value,
        fetching: query.isFetching.value && locked.value === undefined,
        wanted: (resolved.enabled === undefined || toValue(resolved.enabled) !== false) && locked.value === undefined,
        retry: () => void query.refetch(),
    }));
    // The pane it is read in says when the answer drawn may be out of date (a slow refresh, one that failed).
    reportQueryFreshness(query, () => standingFailure.value);
    // `error` is the standing failure too, so a view that says the failure from it agrees with `loaded` and does not go
    // blank for a retry the read makes by itself.
    return { query, error: standingFailure, loaded, locked };
}
