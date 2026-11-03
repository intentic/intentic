import { type CachedAsync, cachedAsync } from "@intentic/base/held";
import type { FetchFn } from "../providers.js";

// JOB LISTS, SHARED BY THEIR READERS (../providers.ts): one request per run's job list while it is out, kept past it only
// once the run cannot move.

// A Fix press waits on its run's job list before any agent exists (ci-fix.ts ciFailureEvidence), and reads it three ways
// at once; the board's row read the very same list moments before the press, to draw its stage circles. So readers share
// one request while it is out, and a list is kept past it only once `settled` says it cannot move short of a re-run:
// briefly, which bounds a re-run started outside this sandbox, while one started here forgets it at once. Kept per
// transport, so one test's stand-in never answers another's read.
const JOB_LISTS_FRESH_MS = 120_000;
const JOB_LISTS_KEPT = 100;

interface JobLists<T> {
    // Always asks the vendor, and keeps what it answers: the board's own reads, so its graph is never a kept copy.
    readonly read: (fetchFn: FetchFn, key: string, list: () => Promise<T[]>) => Promise<T[]>;
    // The list as last read, while it is fresh; read otherwise.
    readonly kept: (fetchFn: FetchFn, key: string, list: () => Promise<T[]>) => Promise<T[]>;
    readonly forget: (fetchFn: FetchFn, key: string) => void;
}

export const jobLists = <T>(settled: (jobs: readonly T[]) => boolean): JobLists<T> => {
    const byTransport = new WeakMap<FetchFn, CachedAsync<string, T[]>>();
    const listsOf = (fetchFn: FetchFn): CachedAsync<string, T[]> => {
        const known = byTransport.get(fetchFn);
        if (known !== undefined) {
            return known;
        }
        const fresh = cachedAsync<string, T[]>({ ttlMs: JOB_LISTS_FRESH_MS, maxEntries: JOB_LISTS_KEPT, keep: settled });
        byTransport.set(fetchFn, fresh);
        return fresh;
    };
    return {
        read: (fetchFn, key, list) => {
            const lists = listsOf(fetchFn);
            // The list kept before, and any read still out, go first: this read's answer must postdate the asking, and if
            // it finds the run moving again (a re-run), a kept reader must join it, never be handed the old settled list.
            lists.drop(key);
            return lists.get(key, list);
        },
        kept: (fetchFn, key, list) => listsOf(fetchFn).get(key, list),
        forget: (fetchFn, key) => {
            listsOf(fetchFn).drop(key);
        },
    };
};
