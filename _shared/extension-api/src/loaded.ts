import { computed, type ComputedRef, hasInjectionContext, inject, type InjectionKey, onScopeDispose, ref, watch } from "vue";

// WHAT A VIEW HAS OF SOMETHING IT READS, said once. Every read the app makes (a daemon query, a route's code, an
// extension's view, a hand-rolled fetch) is one of four things, and a view draws from this union rather than from a
// read's raw flags: `isLoading` is false for a read held while the sandbox wakes (an "empty" flash), `isPending` is true
// for ever for a read its view never asked for (a skeleton for ever), and a view choosing between them was where both
// came from. <Await> (components/feedback/Await.vue) is the one place a `Loaded` becomes pixels.

export type Loaded<T> =
    /** Nothing to show yet, and an answer is coming: asked for, or held until the sandbox answers again. */
    | { readonly state: `waiting`; readonly since: number; readonly retry: (() => void) | undefined }
    /** Nothing to show, and the read gave up; `error` is already words a person can read. */
    | { readonly state: `failed`; readonly error: string; readonly retry: (() => void) | undefined }
    /** Something to show: the last answer, and whether a newer one is on its way or the last try at one failed. */
    | { readonly state: `ready`; readonly data: T; readonly refreshing: boolean; readonly refreshError: string | undefined }
    /** Not asked for: the view is waiting on its own input (an id, a choice), not on the read. */
    | { readonly state: `idle` };

/** The facts of one read, whatever made it; `loadedFrom` is what they mean. */
export interface ReadFacts<T> {
    readonly data: T | undefined;
    /** The last try's failure in words, kept while the last good answer (if any) is still shown. */
    readonly error: string | undefined;
    /** An answer is being asked for right now. */
    readonly fetching: boolean;
    /** The view wants an answer: its own gate is open. Being held until the sandbox answers is still wanting one. */
    readonly wanted: boolean;
    readonly retry?: (() => void) | undefined;
}

/**
 * What the facts mean. An answer in hand wins; then a try in flight (a retry after a failure is a wait again, not the
 * failure); then the failure; then a read that is wanted but not yet asked (held, or about to be) is a wait too.
 */
export const loadedFrom = <T>(facts: ReadFacts<T>, since: number): Loaded<T> => {
    const retry = facts.retry;
    if (facts.data !== undefined) {
        return { state: `ready`, data: facts.data, refreshing: facts.fetching, refreshError: facts.error };
    }
    if (facts.fetching) {
        return { state: `waiting`, since, retry };
    }
    if (facts.error !== undefined) {
        return { state: `failed`, error: facts.error, retry };
    }
    return facts.wanted ? { state: `waiting`, since, retry } : { state: `idle` };
};

/**
 * A read's facts as a `Loaded`, its wait stamped with when it began, and joined to the wait of the <Await> region it is
 * read in (`joinAwait`), so that region's placeholder stands until it has answered: the view never has to say so.
 *
 * Only a retry the person asked for (the `retry` this hands out) turns a failure back into a wait. A try the read makes
 * by itself after failing (a refetch on an interval, on focus, on a push) leaves the failure on screen until it answers:
 * counted as a wait, every background try put the region's placeholder back over its failure for a whole retry cycle,
 * so under a read that kept failing a page showed its skeleton nine seconds in ten and its failure for one.
 */
export const useLoaded = <T>(facts: () => ReadFacts<T>, options: { readonly join?: boolean } = {}): ComputedRef<Loaded<T>> => {
    let since = Date.now();
    let waiting = false;
    // A retry the person asked for is in flight; cleared once the read stops fetching, however it ended.
    const asked = ref(false);
    watch(
        () => facts().fetching,
        (fetching) => {
            if (!fetching) {
                asked.value = false;
            }
        },
        // Every change, not the last one per tick: a try that starts and ends between two ticks must still clear it.
        { flush: `sync` },
    );
    const loaded = computed(() => {
        const read = facts();
        const own = read.retry;
        const retry =
            own === undefined
                ? undefined
                : (): void => {
                      asked.value = true;
                      own();
                  };
        const quiet = read.data === undefined && read.error !== undefined && read.fetching && !asked.value;
        const next = loadedFrom({ ...read, fetching: quiet ? false : read.fetching, retry }, since);
        if (next.state === `waiting` && !waiting) {
            since = Date.now();
            waiting = true;
            return { ...next, since };
        }
        waiting = next.state === `waiting`;
        return next;
    });
    if (options.join !== false) {
        joinAwait(() => loaded.value);
    }
    return loaded;
};

/** Several reads drawn as one: ready with every answer once all are, waiting while any is, failed if any gave up. */
export const allLoaded = <const T extends readonly unknown[]>(reads: { readonly [K in keyof T]: Loaded<T[K]> }): Loaded<T> => {
    const waiting = reads.find((read) => read.state === `waiting`);
    if (waiting !== undefined) {
        return waiting;
    }
    const failed = reads.find((read) => read.state === `failed`);
    if (failed !== undefined) {
        return failed;
    }
    const ready = reads.filter((read): read is Extract<Loaded<unknown>, { state: `ready` }> => read.state === `ready`);
    if (ready.length < reads.length) {
        return { state: `idle` };
    }
    const data: readonly unknown[] = ready.map((read) => read.data);
    return {
        state: `ready`,
        // SAFETY: every read is ready (checked above), and each answer sits at its own read's index.
        data: data as T,
        refreshing: ready.some((read) => read.refreshing),
        refreshError: ready.find((read) => read.refreshError !== undefined)?.refreshError,
    };
};

/** One answer as a `Loaded`: what a view has once the answer it holds is turned into what it draws, else as it was. */
export const mapLoaded = <T, U>(read: Loaded<T>, select: (data: T) => U): Loaded<U> =>
    read.state === `ready` ? { ...read, data: select(read.data) } : read;

/** The answer, when there is one: for a view's script, which reads the data its template only draws under <Await>. */
export const dataOf = <T>(read: Loaded<T>): T | undefined => (read.state === `ready` ? read.data : undefined);

// THE WAIT A REGION HOLDS. An <Await> provides one: every read made inside it while it first draws joins, and the
// region shows what it last looked like (its imprint) instead of its insides until all of them have answered.
interface AwaitScope {
    readonly join: (read: () => Loaded<unknown>) => void;
    readonly leave: (read: () => Loaded<unknown>) => void;
}

export const AWAIT_SCOPE: InjectionKey<AwaitScope> = Symbol(`await-scope`);

/** Joins a read to the wait of the region it is read in, for as long as the caller lives; outside one, nothing. */
export const joinAwait = (read: () => Loaded<unknown>): void => {
    if (!hasInjectionContext()) {
        return;
    }
    const scope = inject(AWAIT_SCOPE, undefined);
    if (scope === undefined) {
        return;
    }
    scope.join(read);
    onScopeDispose(() => scope.leave(read));
};
