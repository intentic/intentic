import type { QueryClient, QueryKey } from "@tanstack/vue-query";
import { queryClient as sharedClient } from "./queryPersistence";

// AN EDIT SHOWN BEFORE THE SERVER HAS AGREED TO IT, and taken back exactly when it does not. The change lands on the
// cached entry synchronously, inside the call and before its first await, so a caller's very next line already reads
// it; a read in flight is cancelled so its older answer cannot put the row back; and a failed write takes the edit
// back, rather than leaving the row gone until some later read happens to bring it back.
//
// How it is taken back is the caller's to say. By default the entry is restored as it was a moment before, which is
// right for an entry only this edit writes. An entry a push also writes (a ledger, a list the daemon announces) wants
// `undo`, which takes back only what this edit touched from the entry as it is NOW: restoring the whole snapshot would
// also undo whatever the push brought in while the write was out.

export interface OptimisticOptions<T> {
    // Re-read the entry once the write has settled either way: for a list the daemon may have changed by more than this
    // edit (a kill that also ended a sibling, a close that relisted).
    readonly settle?: boolean;
    // Runs before the entry is taken back, for state outside the cache the restore depends on.
    readonly onRollback?: () => void;
    // Takes this edit back off the entry as it now is, given the entry as it was before the edit (restoreRows and
    // restoreFields below are the usual two). Without it, the entry is put back whole.
    readonly undo?: (current: T, before: T) => T;
    readonly client?: QueryClient;
}

export const optimisticUpdate = async <T, R>(
    key: QueryKey,
    change: (current: T) => T,
    write: () => Promise<R>,
    { settle = false, onRollback, undo, client = sharedClient }: OptimisticOptions<T> = {},
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
        // Nothing was read, so nothing was changed and there is nothing to take back.
        if (snapshot !== undefined) {
            client.setQueryData<T>(key, (current) => (undo === undefined || current === undefined ? snapshot : undo(current, snapshot)));
        }
        throw error;
    } finally {
        if (settle) {
            await client.invalidateQueries({ queryKey: key });
        }
    }
};

/**
 * An `undo` for a list: the rows with these ids go back to how they were before the edit, and every other row stays
 * as it now is. A row the edit removed comes back where it stood; one the edit added goes away again.
 */
export const restoreRows =
    <Row>(idOf: (row: Row) => string, ids: readonly string[]) =>
    (current: readonly Row[], before: readonly Row[]): Row[] => {
        const touched = new Set(ids);
        const was = new Map(before.flatMap((row, index) => (touched.has(idOf(row)) ? [[idOf(row), { row, index }] as const] : [])));
        const placed = new Set<string>();
        const rows = current.flatMap((row) => {
            const id = idOf(row);
            if (!touched.has(id)) {
                return [row];
            }
            const earlier = was.get(id);
            if (earlier === undefined || placed.has(id)) {
                return [];
            }
            placed.add(id);
            return [earlier.row];
        });
        // Put back in the order they stood, so each lands at the index it held among the rows before it.
        for (const [id, { row, index }] of [...was].sort(([, a], [, b]) => a.index - b.index)) {
            if (!placed.has(id)) {
                rows.splice(Math.min(index, rows.length), 0, row);
            }
        }
        return rows;
    };

/** An `undo` for one object: these fields go back to how they were before the edit, the rest stay as they now are. */
export const restoreFields =
    <T extends object>(fields: readonly (keyof T)[]) =>
    (current: T, before: T): T => {
        const restored = { ...current };
        for (const field of fields) {
            restored[field] = before[field];
        }
        return restored;
    };

/** The fields `next` gives a different value from `previous`: what a whole-object write actually changes. */
export const changedFields = <T extends object>(previous: T, next: T): (keyof T)[] =>
    // SAFETY: the keys are read off the two objects themselves, so each is a key of T.
    (Object.keys({ ...previous, ...next }) as (keyof T)[]).filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field]));

/** An `undo` for a whole-object write of `next`: the fields it changed go back, the rest stay as they now are. */
export const restoreChanged =
    <T extends object>(next: T) =>
    (current: T, before: T): T =>
        restoreFields<T>(changedFields(before, next))(current, before);
