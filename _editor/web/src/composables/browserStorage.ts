/* Browser storage is optional infrastructure, not an authentication prerequisite. Access can throw before a
 * method is even called (blocked cookies, hardened webviews, sandboxed frames), so every auth-path operation
 * goes through this boundary and keeps the in-memory session usable when persistence is unavailable. */
const local = (): Storage | undefined => {
    try {
        return globalThis.localStorage;
    } catch {
        return undefined;
    }
};

export const storedValue = (key: string): string | undefined => {
    try {
        return local()?.getItem(key) ?? undefined;
    } catch {
        return undefined;
    }
};

export const storeValue = (key: string, value: string): void => {
    try {
        local()?.setItem(key, value);
    } catch {
        // The in-memory owner remains authoritative for this tab.
    }
};

export const removeStoredValue = (key: string): void => {
    try {
        local()?.removeItem(key);
    } catch {
        // Absence is already the caller's in-memory state.
    }
};

export const storedKeys = (prefix: string): readonly string[] => {
    try {
        const storage = local();
        if (storage === undefined) {
            return [];
        }
        const keys: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key?.startsWith(prefix) === true) {
                keys.push(key);
            }
        }
        return keys;
    } catch {
        return [];
    }
};
