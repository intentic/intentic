import type { ChatMessage } from "./transcript";

// Local IndexedDB mirror of each conversation's transcript, so reopening paints from disk instead of a sandbox
// round-trip; the daemon stays authoritative and replaces the cache once it answers, so a stale mirror only costs a
// repaint. Keyed by conversationId alone: those are UUIDs, so they can't collide across sandboxes.

const DB_NAME = `intentic.chat`;
const DB_VERSION = 1;
const STORE = `transcripts`;

// Only the tail is kept: a repaint only needs recent history, and the daemon still holds the rest.
const KEPT_MESSAGES = 300;

let connection: Promise<IDBDatabase | undefined> | undefined;

// A build change may reshape ChatMessage, so this drops the whole store (see buildEpoch). Called at boot, before any
// open memoizes `connection`, so the delete can't race a live transaction.
export const dropTranscriptStore = (): void => {
    try {
        indexedDB.deleteDatabase(DB_NAME);
    } catch {
        // Unavailable (private mode, disabled storage), then nothing was mirrored to drop.
    }
};

const openDb = (): Promise<IDBDatabase | undefined> => {
    connection ??= new Promise<IDBDatabase | undefined>((resolve) => {
        try {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(STORE)) {
                    request.result.createObjectStore(STORE);
                }
            };
            request.onsuccess = () => {
                // Closes on a version-change instead of blocking it, so another window's drop doesn't hang forever.
                request.result.onversionchange = () => {
                    request.result.close();
                    connection = undefined;
                };
                resolve(request.result);
            };
            // Blocked, denied, or version-clash: every caller degrades to the uncached path.
            request.addEventListener(`error`, () => resolve(undefined));
            request.onblocked = () => resolve(undefined);
        } catch {
            resolve(undefined);
        }
    });
    return connection;
};

const run = async <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> => {
    const db = await openDb();
    if (db === undefined) {
        return undefined;
    }
    return new Promise<T | undefined>((resolve) => {
        try {
            const request = act(db.transaction(STORE, mode).objectStore(STORE));
            request.onsuccess = () => resolve(request.result);
            request.addEventListener(`error`, () => resolve(undefined));
        } catch {
            resolve(undefined);
        }
    });
};

// Every row field is plain data (a picture is a path, not an object URL), so it structured-clones as-is.
const persistable = (messages: readonly ChatMessage[]): ChatMessage[] => messages.slice(-KEPT_MESSAGES);

// `authoritative` (daemon-confirmed) may shrink the mirror. Any other write only reports what a window happens to show,
// which can be partial, so it may extend the mirror but never truncate it.
export const saveTranscript = async (conversationId: string, messages: readonly ChatMessage[], authoritative = false): Promise<void> => {
    // An empty transcript means no mirror, not a mirror of nothing; writing it would blank a good cache entry.
    if (messages.length === 0) {
        return;
    }
    if (!authoritative) {
        const cached = await readTranscript(conversationId);
        if (cached !== undefined && cached.length > messages.length) {
            return;
        }
    }
    await run(`readwrite`, (store) => store.put(persistable(messages), conversationId));
};

export const readTranscript = async (conversationId: string): Promise<ChatMessage[] | undefined> => {
    const cached = await run<ChatMessage[]>(`readonly`, (store) => store.get(conversationId));
    return Array.isArray(cached) && cached.length > 0 ? cached : undefined;
};

// Closing a tab is the clear signal to drop this entry; without it the store would grow for the life of the profile.
// Reopening later just re-fetches and re-warms it.
export const dropTranscript = async (conversationId: string): Promise<void> => {
    await run(`readwrite`, (store) => store.delete(conversationId));
};
