import type { PersistedClient } from "@tanstack/query-persist-client-core";
import { advanceTimersByTimeAsync, freshImport, waitFor } from "@intentic/testing/bun";
import { openAccountPartition, resetAccountPartitionForTests } from "../../app/storage/browserStorage";

// The query cache's snapshot is each account's own (queryPersistence.ts): kept under `intentic-query-cache:<account>`
// beside the others', so switching back to an account paints its workspace at once, and forgetting one account leaves
// the rest. IndexedDB is a map; the account drawers are the real ones.

// The one IndexedDB store idb-keyval writes to, as a map.
const store = new Map<string, PersistedClient | string>();
jest.mock(`idb-keyval`, () => ({
    get: async (key: string) => store.get(key),
    set: async (key: string, value: PersistedClient) => {
        store.set(key, value);
    },
    del: async (key: string) => {
        store.delete(key);
    },
    keys: async () => [...store.keys()],
}));

// Each case its own copy: the module installs its persister once per page.
const load = (): Promise<typeof import("../queryPersistence")> => freshImport(`../queryPersistence`, import.meta.url);

beforeEach(() => {
    store.clear();
    resetAccountPartitionForTests();
});

afterEach(() => {
    jest.useRealTimers();
    localStorage.clear();
    resetAccountPartitionForTests();
});

it(`writes the snapshot under the name of the account the page is drawn for`, async () => {
    openAccountPartition(`acc-a`);
    const { queryClient, restorePersistedQueries } = await load();
    await restorePersistedQueries(`acc-a`);

    jest.useFakeTimers();
    queryClient.setQueryData([`projects`], [`billing`]);
    // The snapshot waits for the cache to settle and the page to be idle.
    await advanceTimersByTimeAsync(5_000);
    jest.useRealTimers();

    await waitFor(() => expect([...store.keys()]).toEqual([`intentic-query-cache:acc-a`]));
});

describe(`forgetting the snapshot`, () => {
    const EVERY_SNAPSHOT = [`intentic-query-cache`, `intentic-query-cache:acc-a`, `intentic-query-cache:acc-b`];

    beforeEach(() => {
        for (const key of EVERY_SNAPSHOT) {
            store.set(key, key);
        }
        // Another database's record in the same store, which no account owns.
        store.set(`intentic-other`, `kept`);
    });

    it(`forgets one account's snapshot and the one from before accounts had their own, and keeps the others'`, async () => {
        openAccountPartition(`acc-b`);
        const { clearPersistedQueries } = await load();

        await clearPersistedQueries({ account: `acc-a` });

        expect([...store.keys()].toSorted()).toEqual([`intentic-other`, `intentic-query-cache:acc-b`]);
    });

    it(`forgets the open account's snapshot when none is named`, async () => {
        openAccountPartition(`acc-b`);
        const { clearPersistedQueries } = await load();

        await clearPersistedQueries();

        expect([...store.keys()].toSorted()).toEqual([`intentic-other`, `intentic-query-cache:acc-a`]);
    });

    it(`forgets every account's snapshot when every account signs out`, async () => {
        openAccountPartition(`acc-a`);
        const { clearPersistedQueries } = await load();

        await clearPersistedQueries(`every`);

        expect([...store.keys()]).toEqual([`intentic-other`]);
    });
});
