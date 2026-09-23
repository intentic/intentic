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
