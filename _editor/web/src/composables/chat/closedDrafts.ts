import { computed, type ComputedRef, shallowRef, watch } from "vue";
import { onChatNote, postChatNote } from "./chatChannel";
import { readStoredTabs, type StoredTab } from "./tabSnapshot";
import { useSandbox } from "../sandbox/useSandbox";

/* THE WORDS A CLOSE WOULD HAVE THROWN AWAY, kept where every window can see them.
 *
 * Closing a chat costs nothing and asks nothing, deliberately: the transcript is in History, the session is the
 * daemon's, and reopening the agent brings the tab straight back (useChat.closeTabs). Exactly one thing a chat
 * holds is not like that — the message standing in its composer. It exists in the browser and nowhere else, it
 * is the user's own writing, and the × next to it is a single unconfirmed press. So a close that finds one does
 * not destroy it: the tab's whole portable description (StoredTab, draft, staged attachments, queued messages
 * and all) is set aside here, the fleet board keeps drawing a card for it, and opening that card puts the words
 * back in the composer they were typed into.
 *
 * KEPT PER BROWSER, NOT PER WINDOW, which is what the tab strip and its snapshot are (windowStore has why).
 * That is forced by where the report came from: the chat was POPPED OUT, so the × was pressed in one window and
 * the board that has to keep the card is in another. A per-window store would leave the board with nothing to
 * draw and the words recoverable only in the window that closed them, which is the surface the user has just
 * dismissed. localStorage for the same reason the seed uses it — the drafts outlive the window, the browser
 * restart, and the machine going to sleep — with a note on the chat's channel (chatChannel.ts) so the other
 * windows react NOW rather than at their next load (a `storage` event would do half of this, but not for the
 * window that wrote). The same channel the strip itself travels on, deliberately: a close in the floating
 * window says "these words are set aside" and then "that tab is gone", and one channel is what makes every
 * board hear them in that order, so the card changes state once rather than vanishing between the two.
 *
 * SCOPED BY SANDBOX, like the tab snapshot it is made of: these name conversations of one daemon, and a window
 * pointed at another box has no business drawing them.
 *
 * AN ENTRY LEAVES ONLY BY BEING CLAIMED, when the chat is opened again (useChat.reveal) or the card is
 * dismissed for good (the board's ×). There is no sweep and no expiry: a half-written message is not litter,
 * and the one thing worse than a card that lingers is a message that vanished on a schedule. The cap below is
 * the only bound, and it exists for the storage quota rather than for tidiness. */

// How many closed drafts a sandbox keeps. Deep enough that nobody reaches it by working (drafts leave as they
// are reopened), shallow enough that a pathological session cannot fill the origin's storage with transcript-
// sized blobs. The OLDEST goes when it overflows: the words most recently put down are the ones still wanted.
const KEEP = 30;

const storageKey = (sandboxId: string): string => `intentic.closedDrafts.${sandboxId}`;

const read = (sandboxId: string | undefined): readonly StoredTab[] => {
    if (sandboxId === undefined) {
        return [];
    }
    try {
        const raw = localStorage.getItem(storageKey(sandboxId));
        return raw === null ? [] : readStoredTabs(raw);
    } catch {
        // Site data off, or a blob this build cannot read: the app runs with nothing set aside, which is the
        // state it was in before anything was.
        return [];
    }
};

const write = (sandboxId: string | undefined, tabs: readonly StoredTab[]): void => {
    if (sandboxId === undefined) {
        return;
    }
    try {
        localStorage.setItem(storageKey(sandboxId), JSON.stringify({ tabs }));
    } catch {
        // Unavailable or over quota. The in-memory set below still holds for the life of these windows, so the
        // words are recoverable now and merely not after a reload.
    }
};

// The set this window is holding, newest first, for the sandbox it is pointed at.
const kept = shallowRef<readonly StoredTab[]>([]);

/** The chats closed with words still in them, newest first. The board draws them; nothing else has to know they
 *  are any different from an open tab's draft. */
export const closedDrafts: ComputedRef<readonly StoredTab[]> = computed(() => kept.value);

const { activeSandboxId } = useSandbox();

// Load the box being pointed at, and re-load on every switch: these are per sandbox, and carrying one box's
// drafts onto another's board would offer to reopen conversations that daemon has never heard of.
watch(activeSandboxId, (sandboxId) => (kept.value = read(sandboxId)), { immediate: true });

// The whole set, never a patch: the last note wins, the same presence rule the roster and the strip echo already
// follow, so a window that missed one is corrected by the next rather than left diverging.
const publish = (tabs: readonly StoredTab[]): void => {
    kept.value = tabs;
    write(activeSandboxId.value, tabs);
    postChatNote({ kind: `closed-drafts`, tabs });
};

/** Set a closing chat's words aside. Called by the one close path (useChat.closeTabs) for every tab that holds
 *  something unsent, and by nothing else: a tab closed empty is closed, and this is not a history of tabs. */
export const keepClosedDraft = (tab: StoredTab): void => {
    publish([tab, ...kept.value.filter((entry) => entry.conversationId !== tab.conversationId)].slice(0, KEEP));
};

/* TAKE THEM BACK, for the chats a reveal is reopening: the entries are returned AND dropped, because the words
 * are about to live in a composer again and two copies of a draft is how one of them goes stale.
 *
 * CLAIMED ONCE PER REVEAL, BY THE WINDOW THAT WAS PRESSED, which then carries what it took to the app's other
 * windows on the summons itself (summon.ts). Letting each window reach in here as it applied the reveal is what
 * the first cut did, and it lost the message it was written to save: reopening a chat is a broadcast, the first
 * window to resolve the entry emptied this store, and with the chat POPPED OUT that window is the board's, whose
 * copy of the conversation is on no screen at all. The floating window, the one actually drawing the chat, then
 * rebuilt the tab from an entry that no longer existed and opened the composer empty.
 *
 * Taken as ONE claim (rather than a call per chat) so a reveal carrying several — a Shift-run of cards into
 * panes — writes and broadcasts the remainder once. */
export const claimClosedDrafts = (conversationIds: readonly string[]): readonly StoredTab[] => {
    const wanted = new Set(conversationIds);
    const found = kept.value.filter((entry) => wanted.has(entry.conversationId));
    if (found.length > 0) {
        publish(kept.value.filter((entry) => !wanted.has(entry.conversationId)));
    }
    return found;
};

/** ...and let one go without reopening it: the board's × on a card that stands for nothing but these words,
 *  which is the user saying they are done with them. */
export const forgetClosedDraft = (conversationId: string): void => {
    if (kept.value.some((entry) => entry.conversationId === conversationId)) {
        publish(kept.value.filter((entry) => entry.conversationId !== conversationId));
    }
};

// Another window's set, arriving here (the channel has already dropped another sandbox's).
onChatNote(`closed-drafts`, (note) => {
    kept.value = note.tabs;
});
