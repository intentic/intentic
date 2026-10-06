import type { QueryClient, QueryKey } from "@tanstack/vue-query";
import { queryClient as sharedClient } from "./queryPersistence";

// AN EDIT SHOWN BEFORE THE SERVER HAS AGREED TO IT, and taken back exactly when it does not. The change lands on the
// cached entry synchronously, inside the call and before its first await, so a caller's very next line already reads
// it; a read in flight is cancelled so its older answer cannot put the row back; and a failed write restores the entry
// as it was a moment before, rather than leaving the row gone until some later read happens to bring it back.

export interface OptimisticOptions {
    // Re-read the entry once the write has settled either way: for a list the daemon may have changed by more than this
    // edit (a kill that also ended a sibling, a close that relisted).
    readonly settle?: boolean;
    // Runs before the entry is restored, for state outside the cache the restore depends on.
    readonly onRollback?: () => void;
    readonly client?: QueryClient;
}

export const optimisticUpdate = async <T, R>(
    key: QueryKey,
    change: (current: T) => T,
    write: () => Promise<R>,
    { settle = false, onRollback, client = sharedClient }: OptimisticOptions = {},
): Promise<R> => {
    const snapshot = client.getQueryData<T>(key);
    if (snapshot !== undefined) {
        client.setQueryData<T>(key, change(snapshot));
    }
    try {
        await client.cancelQueries({ queryKey: key });
        return await write();
    } catch (error) {
        onRollback?.();
        client.setQueryData(key, snapshot);
        throw error;
    } finally {
        if (settle) {
            await client.invalidateQueries({ queryKey: key });
        }
    }
};
