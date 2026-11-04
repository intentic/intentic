// Storage is optional and never throws: unreadable values are absent, failed writes are dropped, and in-memory state wins.
// deviceKey survives sign-out; accountKey/accountKeys and sandboxKeys (<prefix><sandboxId>) are cleared on sign-out.
// Non-storage state (IndexedDB mirrors, module caches) registers with onAccountCleared; clearAccountStorage clears it too.
//
// EACH ACCOUNT HAS A DRAWER OF ITS OWN. A browser can be signed in to several accounts at once, one of them active, and a
// page is drawn for exactly one of them for its whole life (the editor's lib/accounts/accountBoundary.ts). An account key
// is stored inside that account's partition, `intentic@<accountId>/<key>`, so switching to another account and back
// finds the first one's open sandbox, drafts and credentials as it left them, and no account ever reads another's: a
// daemon session or a Google token is the account's own, and a sandbox both can open would otherwise hand one person's
// to the other. Which partition is open is read from a device key on first use, before the page knows who is signed in,
// since stores read their keys at import; the boundary opens another one and reloads the page when that was wrong.
// Callers never see a partition: they read and write the same names as before, and `storedKeys` lists only the open
// account's keys beside the device's. With no partition open (nobody signed in yet), account keys sit unprefixed as
// they always did, and the first account opened afterwards adopts them.

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

// The raw primitives, on the name as stored.
const rawValue = (key: string, which: StorageArea): string | undefined => {
    try {
        return area(which)?.getItem(key) ?? undefined;
    } catch {
        // allow(silent-catch): a read storage refuses is a value never stored, the same answer as absent.
        return undefined;
    }
};

const rawStore = (key: string, value: string, which: StorageArea): void => {
    try {
        area(which)?.setItem(key, value);
    } catch {
        // allow(silent-catch): off or over quota: the write is dropped and the caller's in-memory value holds for the window.
    }
};

const rawRemove = (key: string, which: StorageArea): void => {
    try {
        area(which)?.removeItem(key);
    } catch {
        // allow(silent-catch): a removal storage refuses leaves absence, which is already the caller's in-memory state.
    }
};

const rawKeys = (which: StorageArea): readonly string[] => {
    try {
        const storage = area(which);
        if (storage === undefined) {
            return [];
        }
        const keys: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key !== null) {
                keys.push(key);
            }
        }
        return keys;
    } catch {
        // allow(silent-catch): storage that refuses to list holds nothing this window can reach.
        return [];
    }
};

export const storedValue = (key: string, which: StorageArea = `local`): string | undefined => rawValue(physicalKey(key), which);

/** Keeps nothing where storage is off or full, or for an account key once this page's account has gone (`sealAccountWrites`). */
export const storeValue = (key: string, value: string, which: StorageArea = `local`): void => {
    if (sealed && isAccountKey(key)) {
        return;
    }
    rawStore(physicalKey(key), value, which);
};

export const removeStoredValue = (key: string, which: StorageArea = `local`): void => rawRemove(physicalKey(key), which);

/** The keys under `prefix` this page can reach: the device's, and the open account's by the names they were stored under. */
export const storedKeys = (prefix: string, which: StorageArea = `local`): readonly string[] => {
    const open = accountPartition();
    const drawer = open === undefined ? undefined : partitionPrefix(open);
    return rawKeys(which).flatMap((key) => {
        if (key.startsWith(PARTITION_MARK)) {
            const name = drawer !== undefined && key.startsWith(drawer) ? key.slice(drawer.length) : undefined;
            return name !== undefined && name.startsWith(prefix) ? [name] : [];
        }
        // An unprefixed account key while a partition is open is one no account has adopted: nobody's, so not listed.
        if (drawer !== undefined && isAccountKey(key)) {
            return [];
        }
        return key.startsWith(prefix) ? [key] : [];
    });
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

/**
 * Forgets what an account left in one place that is not a storage key. Told which account: an id is one account's drawer
 * (its partition, `accountPartition()` when it was open); `undefined` is every account this browser holds.
 */
export type AccountClearer = (account: string | undefined) => void | Promise<void>;

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

/* ---- partitions: one drawer per account ---- */

// Every partitioned key begins with this, then the account id and a slash: `intentic@<id>/intentic.chatTabs.<sandbox>`.
const PARTITION_MARK = `intentic@`;
// Which account's drawer this browser opens, read by every page before it knows who is signed in. A device key: it is
// about which account the browser is on, not anything an account holds.
export const ACCOUNT_POINTER_KEY = deviceKey(`intentic.signedInAs`);

// An id goes into a key as itself where it is plain (Better Auth's are), escaped otherwise, so no id can reach past its
// slash into another's drawer.
const partitionPrefix = (account: string): string => `${PARTITION_MARK}${/^[\w-]+$/u.test(account) ? account : encodeURIComponent(account)}/`;

// allow(module-state): the drawer this page reads and writes, fixed for its life once read (a change is a reload)
let opened: { readonly account: string | undefined } | undefined;
// allow(module-state): whether this page's account has gone from it, so what it still writes on its way out (a snapshot on
// `pagehide`, a debounced draft) cannot put back what was just cleared, or land in a drawer that is no longer its
let sealed = false;

/**
 * This page writes no more account keys until a drawer is opened again: its account has gone (signed out, or the browser
 * moved to another account) and the page is on its way out or about to be refilled. Reads and device keys go on.
 */
export const sealAccountWrites = (): void => {
    sealed = true;
};

/** The account whose partition is open, read from the pointer on first use; undefined while nobody's is. */
export const accountPartition = (): string | undefined => {
    opened ??= { account: rawValue(ACCOUNT_POINTER_KEY, `local`) };
    return opened.account;
};

// Where a key is stored: an account key inside the open drawer, anything else under its own name.
const physicalKey = (key: string): string => {
    if (!isAccountKey(key)) {
        return key;
    }
    const open = accountPartition();
    return open === undefined ? key : `${partitionPrefix(open)}${key}`;
};

// The keys of one drawer as stored, in one area.
const drawerKeys = (account: string, which: StorageArea): readonly string[] => {
    const drawer = partitionPrefix(account);
    return rawKeys(which).filter((key) => key.startsWith(drawer));
};

// Account keys no drawer holds: from before partitions, or written while nobody was signed in.
const unadopted = (which: StorageArea): readonly string[] => rawKeys(which).filter((key) => !key.startsWith(PARTITION_MARK) && isAccountKey(key));

export interface OpenedPartition {
    /** Whether this page may already hold another drawer's values (or values the drawer it opened did not hold): reload it. */
    readonly stale: boolean;
}

/**
 * Opens one account's drawer for this page and points the browser at it (`undefined`: nobody's). Account keys no drawer
 * holds are adopted into it, never over a value it already has. Says whether what this page already read came from
 * somewhere else, which only a reload can put right: the stores that read at import kept it.
 */
export const openAccountPartition = (account: string | undefined): OpenedPartition => {
    const before = accountPartition();
    sealed = false;
    if (account === undefined) {
        rawRemove(ACCOUNT_POINTER_KEY, `local`);
    } else {
        rawStore(ACCOUNT_POINTER_KEY, account, `local`);
    }
    if (before === account) {
        return { stale: false };
    }
    let heldAlready = false;
    if (account !== undefined) {
        const drawer = partitionPrefix(account);
        for (const which of [`local`, `session`] as const) {
            heldAlready ||= drawerKeys(account, which).length > 0;
            for (const key of unadopted(which)) {
                const value = rawValue(key, which);
                if (value !== undefined && rawValue(`${drawer}${key}`, which) === undefined) {
                    rawStore(`${drawer}${key}`, value, which);
                }
                rawRemove(key, which);
            }
        }
    }
    opened = { account };
    // From nobody's to a drawer that held nothing, what was read is exactly what was adopted: nothing to put right.
    return { stale: before !== undefined || heldAlready };
};

// Runs every clearer on its own: one that throws or rejects leaves the rest to run.
const runClearers = async (account: string | undefined): Promise<void> => {
    await Promise.allSettled([...accountClearers].map(async (clear) => clear(account)));
};

/**
 * Removes one account's keys from both storage areas (the open account's by default) with any no drawer holds, and runs
 * every registered clearer for it, each on its own: one that throws or rejects leaves the rest to run. Device keys and
 * other accounts' drawers stay.
 */
export const clearAccountStorage = async (account: string | undefined = accountPartition()): Promise<void> => {
    for (const which of [`local`, `session`] as const) {
        for (const key of [...(account === undefined ? [] : drawerKeys(account, which)), ...unadopted(which)]) {
            rawRemove(key, which);
        }
    }
    await runClearers(account);
};

/** Removes every account's keys, every drawer and every clearer's copy: the browser keeps only what is the device's. */
export const clearEveryAccountStorage = async (): Promise<void> => {
    for (const which of [`local`, `session`] as const) {
        for (const key of rawKeys(which).filter((name) => name.startsWith(PARTITION_MARK) || isAccountKey(name))) {
            rawRemove(key, which);
        }
    }
    await runClearers(undefined);
};

/** For tests: forget which drawer was read, so the next use reads the pointer again. */
export const resetAccountPartitionForTests = (): void => {
    opened = undefined;
    sealed = false;
};
