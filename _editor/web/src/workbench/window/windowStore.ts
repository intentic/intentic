import { removeStoredValue, type StorageArea, storedValue, storeValue } from "../../app/storage/browserStorage";

// A window's own view state (open tabs, expanded folders) lives in sessionStorage, authoritative for this window;
// localStorage holds the same blob as a seed for a window that has never held it. The seed is last-writer-wins,
// harmless since no open window reads it back. Storage that is off or full reads as nothing and keeps nothing; the
// in-memory state still holds for this window's lifetime.

// This window's own state, or the seed from the last window if this one never held it; `parse` decides what's usable,
// so an unreadable session blob falls through to the seed.
export const readWindowState = <T>(key: string, parse: (raw: string) => T | undefined): T | undefined => {
    for (const area of [`session`, `local`] satisfies StorageArea[]) {
        const raw = storedValue(key, area);
        const parsed = raw === undefined ? undefined : parse(raw);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    return undefined;
};

// Persists this window's state and re-seeds the next fresh window with it. Takes serialized JSON since callers already
// watch that string for changes.
export const writeWindowState = (key: string, json: string): void => {
    storeValue(key, json, `session`);
    storeValue(key, json, `local`);
};

// Clears this window's session state, so its next read falls through to the seed; used when the chat moves into its own
// window (floating.ts), so docking back reads the floating window's current state instead of a stale copy.
export const forgetWindowState = (key: string): void => {
    removeStoredValue(key, `session`);
};
