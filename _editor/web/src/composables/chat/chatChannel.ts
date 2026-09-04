import { reloadOnHotUpdate } from "../hotReload";
import { useSandbox } from "../sandbox/useSandbox";
import type { Summons } from "./summon";
import type { Strip } from "./tabFacts";
import type { StoredTab } from "./tabSnapshot";

/* EVERYTHING THE CHAT SAYS TO THE APP'S OTHER WINDOWS, on one channel.
 *
 * The app runs as a full copy per browser window and the chat panel is drawn by exactly one of them at a time
 * (composables/floating.ts), so the chat has three things to tell the windows that are not drawing it: a
 * gesture made on a board that reaches the panel (summon.ts), what the panel's strip currently holds
 * (chatEcho.ts), and which closed chats still have a message set aside in them (closedDrafts.ts). Each of
 * those used to own a BroadcastChannel of its own, and the seams between them were where the popped-out chat
 * kept breaking: a close in the floating window set a message aside on one channel and dropped the tab on
 * another, and the board hearing them out of order drew, for a beat, a chat that was neither open nor kept.
 *
 * ONE CHANNEL MEANS ONE ORDER. A BroadcastChannel delivers a poster's messages in the order they were posted,
 * so "these words are set aside" always lands before "that tab is gone", and a receiving board changes state
 * once, from the one to the other. It also means one sandbox guard, applied on the envelope rather than by
 * every reader for itself: the chat's notes name one daemon's conversations, and a window pointed at another
 * box quietly drops the lot. Same-origin only, which is a BroadcastChannel's own scope and the boundary of
 * "the same app".
 *
 * WHAT DOES NOT RIDE IT is the same as before: queued turns (a copy in another window would be sent twice),
 * and the whole of a half-written message beyond what a card needs to name itself (tabFacts.ts). */

export type ChatNote =
    /* A gesture made outside the panel, for every window's panel to apply (summon.ts). */
    | { readonly kind: `summons`; readonly summons: Summons }
    /* What the window drawing the chat is showing, for every window that is not (chatEcho.ts). A snapshot,
     * never a patch: the last one heard is the whole truth, the presence rule every note in this app follows. */
    | { readonly kind: `strip`; readonly strip: Strip }
    /* "Say what you are showing": what a window asks when it boots (or switches sandbox) while another window
     * already holds the chat, since asking is cheaper than waiting for the next change out there. */
    | { readonly kind: `roll` }
    /* The chats closed with a message still in them, the whole set (closedDrafts.ts). */
    | { readonly kind: `closed-drafts`; readonly tabs: readonly StoredTab[] };

// The wire form: which sandbox's chats the note is about, then the note. `undefined` is a window that has not
// resolved its sandbox yet, and matches only another such window.
export interface ChatEnvelope {
    readonly sandbox: string | undefined;
    readonly note: ChatNote;
}

type NoteOf<K extends ChatNote["kind"]> = Extract<ChatNote, { kind: K }>;

// One reader per kind: the module that owns that note installs itself at load. A Map rather than a switch so
// this file names no module that reads it, and a re-imported module (a test's fresh realm) simply takes over.
const readers = new Map<ChatNote["kind"], (note: ChatNote) => void>();

/** Read every note of one kind arriving from another window. */
export const onChatNote = <K extends ChatNote["kind"]>(kind: K, read: (note: NoteOf<K>) => void): void => {
    readers.set(kind, read as (note: ChatNote) => void);
};

// Guarded like every channel in this app: a runtime without BroadcastChannel (tests, SSR) is a single-window
// app, which is exactly what no channel means.
const channel = typeof window === `undefined` || window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.chat`);

/** Tell every other window. A BroadcastChannel never delivers to its own poster, so a module that also wants
 *  the note applied here applies it itself (summon.ts does; the strip echo deliberately does not).
 *
 *  AS JSON, which is the wire form of everything on this channel rather than a detail of how it is posted. The
 *  browser copies a posted message by structured clone, and structured clone REFUSES A PROXY, which is what a
 *  Vue ref hands back for any object it holds. A tab's snapshot (tabSnapshot.snapshotTab) carries the
 *  conversation's session, its displaced pick, its stopped turn and its fork linkage exactly as the refs hold
 *  them, so a summons for any chat with a session in it threw DataCloneError out of the click that made it,
 *  AFTER the local apply and BEFORE any other window heard a word: every rail click in the popped-out chat did,
 *  and the board went on ringing the chat before it; a "New agent" over a displaced draft did, and the floating
 *  window kept showing the old conversation. The strip already crosses as parsed JSON (useChat's publish
 *  watch); this makes it the channel's rule rather than one poster's courtesy. It is also what drops the
 *  `undefined` keys StoredTab's optional fields are read back as absent, so a heard tab and a restored one are
 *  the same shape. */
export const postChatNote = (note: ChatNote): void => {
    if (channel === undefined) {
        return;
    }
    const envelope: ChatEnvelope = { sandbox: useSandbox().activeSandboxId.value, note };
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
    channel.postMessage(JSON.parse(JSON.stringify(envelope)) as ChatEnvelope);
};

/** Another window's note, arriving here: the ONE way in, so what a test hands over and what the channel
 *  delivers travel the identical path (the seam floating.ts keeps for its own notes). */
export const receiveChatNote = (envelope: ChatEnvelope): void => {
    if (envelope.sandbox !== useSandbox().activeSandboxId.value) {
        return;
    }
    readers.get(envelope.note.kind)?.(envelope.note);
};

channel?.addEventListener(`message`, (event: MessageEvent<ChatEnvelope>) => receiveChatNote(event.data));

// One channel and one set of readers per window: a hot update that re-ran this module would leave the browser's
// listener on the first instance, feeding readers of a store the panel no longer renders (hotReload.ts).
reloadOnHotUpdate(import.meta);
