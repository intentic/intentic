// The one door to the browser's key-value storage, for the kit and the editor alike. Storage is optional
// infrastructure: naming `localStorage` throws where site data is off, a write throws over quota, and a value read back
// was written by any earlier build. So nothing here throws: an unreadable value reads as absent, and a write that did
// not stick is dropped, the caller's in-memory state staying authoritative for the window.
//
// Every key is declared in the scope it belongs to:
// - `deviceKey`: a fact about this browser (theme, language, layout, a rail's last pick), kept across sign-out.
// - `accountKey` / `accountKeys`: what the signed-in account left (drafts, prompts, open chats), cleared on sign-out.
// - `sandboxKeys`: one sandbox's, `<prefix><sandboxId>`; a sandbox is reached through an account, so it is the
//   account's too and is cleared with it.
// What is not a storage key (an IndexedDB mirror, a module's in-memory copy) registers its own clearer with
// `onAccountCleared`; `clearAccountStorage` runs all of it.

/** Whatever JSON.parse can hand back: what a stored value is before its schema has read it. */
export type StoredJsonValue = string | number | boolean | null | readonly StoredJsonValue[] | { readonly [key: string]: StoredJsonValue };

/** What a stored JSON value must look like; a zod schema is one, and the kit takes no dependency on zod to say so. */
export interface StoredSchema<T> {
    readonly safeParse: (input: StoredJsonValue) => { readonly success: true; readonly data: T } | { readonly success: false };
}

/** `local` outlives the tab; `session` is this tab's own and survives only its reloads. */
export type StorageArea = `local` | `session`;

const area = (which: StorageArea): Storage | undefined => {
    try {
        return which === `local` ? globalThis.localStorage : globalThis.sessionStorage;
    } catch {
        // allow(silent-catch): naming the storage global throws where site data is off; no storage is the answer.
        return undefined;
    }
};

export const storedValue = (key: string, which: StorageArea = `local`): string | undefined => {
    try {
        return area(which)?.getItem(key) ?? undefined;
    } catch {
        // allow(silent-catch): a read storage refuses is a value never stored, the same answer as absent.
        return undefined;
    }
};

/** Keeps nothing where storage is off or full; the caller's in-memory value still holds for this window. */
export const storeValue = (key: string, value: string, which: StorageArea = `local`): void => {
    try {
        area(which)?.setItem(key, value);
    } catch {
        // allow(silent-catch): off or over quota: the write is dropped and the caller's in-memory value holds for the window.
    }
};

export const removeStoredValue = (key: string, which: StorageArea = `local`): void => {
    try {
        area(which)?.removeItem(key);
    } catch {
        // allow(silent-catch): a removal storage refuses leaves absence, which is already the caller's in-memory state.
    }
};

export const storedKeys = (prefix: string, which: StorageArea = `local`): readonly string[] => {
    try {
        const storage = area(which);
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
        // allow(silent-catch): storage that refuses to list holds nothing this window can reach.
        return [];
    }
};

/** A stored JSON value of the given shape; bad JSON, a value of another shape, or nothing at all read as `undefined`. */
export const storedJson = <T>(key: string, schema: StoredSchema<T>, which: StorageArea = `local`): T | undefined => {
    const raw = storedValue(key, which);
    if (raw === undefined) {
        return undefined;
    }
    try {
        // SAFETY: JSON.parse hands back only JSON values; the schema decides what they mean.
        const parsed = schema.safeParse(JSON.parse(raw) as StoredJsonValue);
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): text that is not JSON is no value, the same answer as one of the wrong shape.
        return undefined;
    }
};

/** Stores a value as JSON; a value JSON cannot hold (a cycle) is dropped like a write storage refused. */
export const storeJson = <T>(key: string, value: T, which: StorageArea = `local`): void => {
    let raw: string;
    try {
        raw = JSON.stringify(value);
    } catch {
        // allow(silent-catch): a value JSON cannot hold (a cycle) is dropped like a write storage refused.
        return;
    }
    storeValue(key, raw, which);
};

// ---- scopes ----

/** Forgets what the account left in one place that is not a storage key. */
export type AccountClearer = () => void | Promise<void>;

// allow(module-state): the account's exact keys, declared once each at import
const accountExact = new Set<string>();
// allow(module-state): the account's key families, by prefix
const accountPrefixes = new Set<string>();
// allow(module-state): what the account left outside storage keys, each told to forget it
const accountClearers = new Set<AccountClearer>();

/** A key that belongs to this browser rather than to whoever is signed in; it is kept across sign-out. */
export const deviceKey = (name: string): string => name;

/** One key the signed-in account owns; sign-out removes it. */
export const accountKey = (name: string): string => {
    accountExact.add(name);
    return name;
};

/** A family of keys the account owns, `<prefix><parts joined by .>`; sign-out removes every key under the prefix. */
export const accountKeys = (prefix: string): ((...parts: readonly string[]) => string) => {
    accountPrefixes.add(prefix);
    return (...parts) => `${prefix}${parts.join(`.`)}`;
};

/** One sandbox's keys, `<prefix><sandboxId>`: the account's, since the account is how its sandboxes are reached. */
export const sandboxKeys = (prefix: string): ((sandboxId: string) => string) => {
    const keyOf = accountKeys(prefix);
    return (sandboxId) => keyOf(sandboxId);
};

/** Whether sign-out removes this key. */
export const isAccountKey = (key: string): boolean => accountExact.has(key) || [...accountPrefixes].some((prefix) => key.startsWith(prefix));

/** Something the account left outside a storage key (an IndexedDB mirror, an in-memory copy); returns its removal. */
export const onAccountCleared = (clear: AccountClearer): (() => void) => {
    accountClearers.add(clear);
    return () => accountClearers.delete(clear);
};

/**
 * Removes every account key from both storage areas and runs every registered clearer, each on its own: one that throws
 * or rejects leaves the rest to run. Device keys stay.
 */
export const clearAccountStorage = async (): Promise<void> => {
    for (const which of [`local`, `session`] as const) {
        for (const key of storedKeys(``, which).filter(isAccountKey)) {
            removeStoredValue(key, which);
        }
    }
    await Promise.allSettled([...accountClearers].map(async (clear) => clear()));
};
