// A cache write the browser refuses (a full or disabled IndexedDB) is dropped, never an unhandled rejection.
import { waitFor } from "@intentic/testing/bun";

const set = jest.fn(async (): Promise<void> => {
    throw new DOMException(`The quota has been exceeded.`, `QuotaExceededError`);
});
jest.mock(`idb-keyval`, () => ({ get: async () => undefined, set, del: async () => undefined }));

const { queryClient, restorePersistedQueries } = await import(`./queryPersistence`);

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
        await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
        // One macrotask for the rejection to surface, were it unhandled.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);
    } finally {
        runtime.off(`unhandledRejection`, record);
    }
});

it(`keeps one write in flight and writes only the newest cache after it`, async () => {
    await restorePersistedQueries(`user_1`);
    set.mockReset();
    let finishFirst: (() => void) | undefined;
    set.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    set.mockResolvedValue(undefined);
    queryClient.setQueryData([`coalesce`, 1], `first`);
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1), { timeout: 3000 });
    queryClient.setQueryData([`coalesce`, 2], `middle`);
    queryClient.setQueryData([`coalesce`, 3], `latest`);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(set).toHaveBeenCalledTimes(1);
    finishFirst?.();
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    // SAFETY: The persister calls this mock with a PersistedClient; the test only reads its query keys.
    const saved = set.mock.calls[1]?.[1] as { clientState: { queries: { queryKey: unknown[] }[] } };
    expect(saved.clientState.queries.map((query) => query.queryKey)).toContainEqual([`coalesce`, 3]);
});
