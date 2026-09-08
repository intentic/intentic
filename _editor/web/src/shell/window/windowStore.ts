// A window's own view state (open tabs, expanded folders) lives in sessionStorage, authoritative for this window;
// localStorage holds the same blob as a seed for a window that has never held it. The seed is last-writer-wins,
// harmless since no open window reads it back. Both accessors are guarded, since touching storage can throw.

const readFrom = (storage: () => Storage, key: string): string | null => {
    try {
        return storage().getItem(key);
    } catch {
        return null;
    }
};

const writeTo = (storage: () => Storage, key: string, json: string): void => {
    try {
        storage().setItem(key, json);
    } catch {
        // Unavailable or over quota; the in-memory state still holds for this window's lifetime.
    }
};

// This window's own state, or the seed from the last window if this one never held it; `parse` decides what's usable,
// so an unreadable session blob falls through to the seed.
export const readWindowState = <T>(key: string, parse: (raw: string) => T | undefined): T | undefined => {
    // Thunks: naming sessionStorage itself throws when site data is off, so access happens inside the try.
    for (const storage of [(): Storage => sessionStorage, (): Storage => localStorage]) {
        const raw = readFrom(storage, key);
        const parsed = raw === null ? undefined : parse(raw);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    return undefined;
};

// Persists this window's state and re-seeds the next fresh window with it. Takes serialized JSON since callers already
// watch that string for changes.
export const writeWindowState = (key: string, json: string): void => {
    writeTo(() => sessionStorage, key, json);
    writeTo(() => localStorage, key, json);
};

// Clears this window's session state, so its next read falls through to the seed; used when the chat moves into its own
// window (floating.ts), so docking back reads the floating window's current state instead of a stale copy.
export const forgetWindowState = (key: string): void => {
    try {
        sessionStorage.removeItem(key);
    } catch {
        // Unavailable; there was nothing remembered here to begin with.
    }
};
