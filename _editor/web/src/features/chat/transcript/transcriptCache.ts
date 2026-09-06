import type { ChatMessage } from "./transcript";

/* A local mirror of each conversation's transcript, so reopening a chat paints from disk instead of waiting on
 * a round-trip to the sandbox, which is a Cloudflare tunnel to a machine that may be asleep, on the far side
 * of a reachability probe. The daemon stays the source of truth: the cache is painted first and then REPLACED
 * by whatever the daemon reports (a live turn reattaches, an idle one rehydrates from the session store), so a
 * stale or partial mirror can only ever cost a repaint, never a wrong transcript.
 *
 * IndexedDB rather than localStorage: transcripts carry tool cards and thinking and run to megabytes, which
 * would blow the 5MB synchronous localStorage budget the tab snapshot already lives in. Every operation
 * degrades to a no-op when IndexedDB is unavailable (private mode, disabled storage), leaving exactly the
 * fetch-on-open behaviour that existed before this cache.
 *
 * Entries are keyed by conversationId alone. Those are client-minted UUIDs, so they cannot collide across
 * sandboxes, and a sandbox's tab snapshot only ever names its own conversations, a sandbox prefix would buy
 * nothing while coupling this module to the sandbox singleton, which reaches browser globals at import time
 * and would drag them into every module that mirrors a transcript. */

const DB_NAME = `intentic.chat`;
const DB_VERSION = 1;
const STORE = `transcripts`;

// The tail of a long conversation is what a repaint needs; the whole history would grow unbounded on disk for
// a view the user has to scroll up to reach anyway (and the daemon still holds all of it).
const KEPT_MESSAGES = 300;

let connection: Promise<IDBDatabase | undefined> | undefined;

// A web update may reshape ChatMessage itself, and a chat paints whatever blob it finds before the daemon
// replaces it, so a build change drops the whole store (see buildEpoch). Called at boot, before any open
// memoizes `connection`, so the delete never races a live transaction or sits blocked behind one.
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
                /* Yield when another window asks for the database, which, with a fixed DB_VERSION, only ever
                 * means a DELETE: an updated window dropping the store (dropTranscriptStore) while this one is
                 * still open. A connection that holds on would leave that delete pending forever, and every
                 * open queued BEHIND it, the updated window's first chat read would hang, not degrade. Closing
                 * costs this window its mirror: the memo is cleared, so the next read reopens (recreating an
                 * empty store) instead of transacting on a closed handle for the rest of the session. */
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

// The tail of the conversation, as it stands: every field on a row is plain data (a picture is a workspace path
// the chip re-fetches, never an object URL) and structured-clones as-is.
const persistable = (messages: readonly ChatMessage[]): ChatMessage[] => messages.slice(-KEPT_MESSAGES);

/* `authoritative` marks a transcript the DAEMON confirmed (a session replay), which is allowed to shrink the
 * mirror, it is the source of truth, and a compacted or trimmed session legitimately has fewer messages than
 * the copy on disk.
 *
 * Every other write is a window reporting what it happens to be showing, and a window can be showing less than
 * the whole conversation: attaching to a turn that is already running renders that turn alone, and its settle
 * used to persist those two or three bubbles over a 300-message mirror, losing the history locally on any
 * reload that landed mid-turn. So an unconfirmed write may extend the mirror, never truncate it. */
export const saveTranscript = async (conversationId: string, messages: readonly ChatMessage[], authoritative = false): Promise<void> => {
    // An empty transcript is the absence of a mirror, not a mirror of nothing, writing it would blank a good
    // cache entry when a conversation is reset before its replacement content arrives.
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

// Closing a tab is the one unambiguous "done with this" signal, and without it the store would grow for the
// life of the browser profile. Reopening from history or the fleet still works, it just pays the fetch again,
// which is exactly the pre-cache behaviour, and the fetch re-warms the mirror.
export const dropTranscript = async (conversationId: string): Promise<void> => {
    await run(`readwrite`, (store) => store.delete(conversationId));
};
