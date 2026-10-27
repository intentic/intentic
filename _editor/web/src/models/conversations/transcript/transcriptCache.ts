import { fitPageRow } from "@intentic/sandbox-contract/text/transcript-page";
import type { Ref } from "vue";
import type { ChatMessage } from "./transcript";
import { activeSandboxId } from "../../../app/storage/activeSandbox";
import { onAccountCleared, TRANSCRIPT_DATABASE } from "../../../app/storage/browserStorage";

// Local IndexedDB mirror of each conversation's transcript, so reopening paints from disk instead of a sandbox
// round-trip; the daemon stays authoritative and replaces the cache once it answers, so a stale mirror only costs a
// repaint. The account's: sign-out deletes the database (lib/browserStorage.ts), which this page's connection gives way
// to on the version change.

// An entry is one sandbox's conversation, never an id alone: an id can name a conversation in every sandbox at once (a
// person's home conversation is named after them in each, ids/conversation-ids.ts homeConversationId), and keyed by the id
// a new sandbox's home painted the transcript of the home in the sandbox before it.
export const mirrorKey = (sandboxId: string | undefined, conversationId: string): string => `${sandboxId ?? ``}/${conversationId}`;

/** The entry of a conversation as it stands: the sandbox it lives in (Conversation.box, else the active one) and its id. */
export const mirrorKeyOf = (conversation: { readonly conversationId: string; readonly box: Readonly<Ref<string | undefined>> }): string =>
    mirrorKey(conversation.box.value ?? activeSandboxId.value, conversation.conversationId);

const DB_NAME = TRANSCRIPT_DATABASE;
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

// Every row field is plain data (a picture is a path, not an object URL), so it structured-clones as-is. Kept as the
// daemon's page carries it (fitPageRow: tool outputs to their start, a delegation's calls counted): a row this window
// streamed holds every byte its calls printed, all of it cloned on the main thread at each write, and a reopen painted
// it from the mirror only for the daemon's page to hand it back fitted, a different row, drawn again.
const persistable = (messages: readonly ChatMessage[]): ChatMessage[] => messages.slice(-KEPT_MESSAGES).map(fitPageRow);

// How many rows each mirror entry held when this window last wrote or read it. An unconfirmed write only has to know
// whether the mirror is longer than what it would write, and reading the entry back to learn that cloned the whole
// record off disk on every turn's end; once this window has touched an entry, it already knows.
const mirroredRows = new Map<string, number>();
// What this window remembers of the mirror goes with it.
onAccountCleared(() => mirroredRows.clear());

/* WHAT THE MIRROR KEEPS WHILE A RUN IS STILL GOING (`open`). A live run's rows are one moment of it, a command card
   spinning, a server it had just started, and a reopen painted that moment as now until the run's live head drew over
   it a second later (2026-10-27: a subagent looked at once, then reopened hours on, flashed a demo server it had long
   stopped). So they stay out of the mirror, and out of what it already holds, and a reopen paints what has settled while
   the run draws itself. A write that is not the daemon's may still not shrink the rest (saveTranscript). */
export const settledMirror = (
    messages: readonly ChatMessage[],
    held: readonly ChatMessage[] | undefined,
    authoritative: boolean,
    open: string,
): ChatMessage[] => {
    const kept = persistable(messages.filter((message) => message.run !== open));
    const heldSettled = authoritative ? undefined : held?.filter((message) => message.run !== open);
    return heldSettled !== undefined && heldSettled.length > kept.length ? heldSettled : kept;
};

// `open` names a run still going, whose rows are left out (settledMirror); nothing settled left means no entry at all.
const saveSettled = async (key: string, messages: readonly ChatMessage[], authoritative: boolean, open: string): Promise<void> => {
    const kept = settledMirror(messages, authoritative ? undefined : await readTranscript(key), authoritative, open);
    if (kept.length === 0) {
        await dropTranscript(key);
        return;
    }
    mirroredRows.set(key, kept.length);
    await run(`readwrite`, (store) => store.put(kept, key));
};

// `authoritative` (daemon-confirmed) may shrink the mirror. Any other write only reports what a window happens to show,
// which can be partial, so it may extend the mirror but never truncate it.
export const saveTranscript = async (key: string, messages: readonly ChatMessage[], authoritative = false, open?: string): Promise<void> => {
    // An empty transcript means no mirror, not a mirror of nothing; writing it would blank a good cache entry.
    if (messages.length === 0) {
        return;
    }
    if (open !== undefined) {
        await saveSettled(key, messages, authoritative, open);
        return;
    }
    const kept = persistable(messages);
    if (!authoritative) {
        const held = mirroredRows.get(key) ?? (await readTranscript(key))?.length;
        if (held !== undefined && held > kept.length) {
            return;
        }
    }
    mirroredRows.set(key, kept.length);
    await run(`readwrite`, (store) => store.put(kept, key));
};

export const readTranscript = async (key: string): Promise<ChatMessage[] | undefined> => {
    const cached = await run<ChatMessage[]>(`readonly`, (store) => store.get(key));
    const found = Array.isArray(cached) && cached.length > 0 ? cached : undefined;
    mirroredRows.set(key, found?.length ?? 0);
    return found;
};

// Closing a tab is the clear signal to drop this entry; without it the store would grow for the life of the profile.
// Reopening later just re-fetches and re-warms it.
export const dropTranscript = async (key: string): Promise<void> => {
    mirroredRows.delete(key);
    await run(`readwrite`, (store) => store.delete(key));
};
