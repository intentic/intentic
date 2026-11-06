// A cache write the browser refuses (a full or disabled IndexedDB) is dropped, never an unhandled rejection.
import type { PersistedClient } from "@tanstack/query-persist-client-core";
import { advanceTimersByTimeAsync, freshImport, waitFor } from "@intentic/testing/bun";

// Typed as idb-keyval's own `set`, so a test reads back the client it was handed.
const set = jest.fn(async (_key: IDBValidKey, _client: PersistedClient): Promise<void> => {
    throw new DOMException(`The quota has been exceeded.`, `QuotaExceededError`);
});
jest.mock(`idb-keyval`, () => ({ get: async () => undefined, set, del: async () => undefined, keys: async () => [] }));

const { queryClient, restorePersistedQueries } = await import(`../queryPersistence`);

// The runtime's own hook for a rejection nobody handled; the web tsconfig types `process` without it.
const runtime = process as unknown as {
    on: (event: `unhandledRejection`, listener: (reason: unknown) => void) => void;
    off: (event: `unhandledRejection`, listener: (reason: unknown) => void) => void;
};

it(`drops a cache write the browser refuses instead of rejecting unhandled`, async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
        unhandled.push(reason);
    };
    runtime.on(`unhandledRejection`, record);
    try {
        await restorePersistedQueries(`user_1`);
        queryClient.setQueryData([`settings`], { theme: `dark` });
        // A hang bound, not a latency: the snapshot is taken when the 2s persist window closes (queryPersistence.ts).
        await waitFor(() => expect(set).toHaveBeenCalledTimes(1), { timeout: 5000 });
        // One macrotask for the rejection to surface, were it unhandled.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);
    } finally {
        runtime.off(`unhandledRejection`, record);
    }
});

describe(`how often the mirror is written`, () => {
    // Each case its own copy, its write interval unopened: the module installs its persister once per page.
    const load = (): Promise<typeof import("../queryPersistence")> => freshImport(`../queryPersistence`, import.meta.url);
    // The mirror's write interval (MIRROR_EVERY_MS) and the settle before a snapshot (PERSIST_WINDOW_MS).
    const INTERVAL_MS = 15_000;
    const SETTLE_MS = 2_000;

    beforeEach(() => {
        set.mockReset();
        set.mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it(`keeps one write in flight, and writes only the newest cache after it once the interval is up`, async () => {
        const { queryClient: cache, restorePersistedQueries: restore } = await load();
        await restore(`user_1`);
        let finishFirst: (() => void) | undefined;
        set.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishFirst = resolve;
                }),
        );
        jest.useFakeTimers();
        cache.setQueryData([`coalesce`, 1], `first`);
        // The first change after a quiet spell is written as soon as it settles.
        await advanceTimersByTimeAsync(SETTLE_MS + 500);
        expect(set).toHaveBeenCalledTimes(1);
        cache.setQueryData([`coalesce`, 2], `middle`);
        cache.setQueryData([`coalesce`, 3], `latest`);
        await advanceTimersByTimeAsync(SETTLE_MS + 500);
        expect(set).toHaveBeenCalledTimes(1);
        finishFirst?.();
        await advanceTimersByTimeAsync(INTERVAL_MS);
        expect(set).toHaveBeenCalledTimes(2);
        const saved = set.mock.calls[1]?.[1];
        expect(saved?.clientState.queries.map((query) => query.queryKey)).toContainEqual([`coalesce`, 3]);
    });

    it(`writes a cache that keeps changing at most once an interval`, async () => {
        const { queryClient: cache, restorePersistedQueries: restore } = await load();
        await restore(`user_1`);
        jest.useFakeTimers();
        for (let second = 0; second < 20; second += 1) {
            cache.setQueryData([`busy`], second);
            await advanceTimersByTimeAsync(1_000);
        }
        // At ~2s the first, at the interval's end (~17s) the newest since.
        expect(set).toHaveBeenCalledTimes(2);
        await advanceTimersByTimeAsync(INTERVAL_MS);
        expect(set).toHaveBeenCalledTimes(3);
        expect(set.mock.calls[2]?.[1].clientState.queries.map((query) => query.state.data)).toEqual([19]);
    });

    it(`writes nothing when every mirrored query still holds what was last written`, async () => {
        const { queryClient: cache, restorePersistedQueries: restore } = await load();
        await restore(`user_1`);
        jest.useFakeTimers();
        const roster = { members: [`ada`, `grace`] };
        cache.setQueryData([`roster`], roster);
        await advanceTimersByTimeAsync(SETTLE_MS + 500);
        expect(set).toHaveBeenCalledTimes(1);
        // A reconnect distrusts everything, and a refetch that answers the same keeps the very object (structural
        // sharing): the cache changed, what the disk would hold did not.
        await cache.invalidateQueries();
        cache.setQueryData([`roster`], roster);
        await advanceTimersByTimeAsync(INTERVAL_MS + SETTLE_MS + 500);
        expect(set).toHaveBeenCalledTimes(1);
        cache.setQueryData([`roster`], { members: [`ada`, `grace`, `linus`] });
        await advanceTimersByTimeAsync(SETTLE_MS + 500);
        expect(set).toHaveBeenCalledTimes(2);
    });
});
