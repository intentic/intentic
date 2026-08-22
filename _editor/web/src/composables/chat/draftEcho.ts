import { computed, type ComputedRef, shallowRef } from "vue";
import { showsPanel } from "../floating";
import { useSandbox } from "../sandbox/useSandbox";

/* HALF-WRITTEN MESSAGES, TOLD TO THE WINDOWS THAT ARE NOT HOLDING THEM.
 *
 * The app runs a full copy per browser window and the chat panel's tab state is deliberately per window
 * (useChat's note). One thing about a tab is therefore knowable in exactly one window: the words sitting in its
 * composer. Everything else a chat holds is the daemon's and converges everywhere on its own.
 *
 * That is fine until the chat is popped out, because then the composer is in one window and the FLEET BOARD is
 * in another, and the board's account of a conversation the user is writing in came out wrong twice over:
 *   · the draft card VANISHED the moment another card was clicked. A draft with nothing in it is swept when the
 *     focus leaves it (useChat.untouchedDraft), and out here the tab looked like exactly that: empty. The words
 *     were one window away, so the board threw away the one card its owner could not rebuild.
 *   · a card that survived had nothing to say about itself: no unsent mark, and "New agent" for a name, while
 *     the message that would have named it sat in the other window.
 *
 * So the window that DRAWS the chat publishes, on a channel of its own, which conversations hold unsent words
 * and the first few of them. Every other window joins its board against that. Two rules keep it honest:
 *   · only the drawing window speaks (`showsPanel`), and only it is believed, a window drawing the panel
 *     reads its own conversations and ignores every echo, so there is no arrangement in which a stale note
 *     outranks the composer itself;
 *   · a window with nothing to say never speaks, which is what keeps a booting window from blanking the note a
 *     live one published a moment earlier.
 *
 * WHAT RIDES IT IS THE PREVIEW, NOT THE MESSAGE. The board only ever draws the first few words (a card needs a
 * name), and a half-written message is the most private thing this app holds: there is no reason for the whole
 * of it to cross a channel any other tab of this origin can listen on.
 *
 * Scoped by sandbox and same-origin, the boundaries the summons channel already keeps (summon.ts). */

// One chat with words in it: the tab's id, and the first few of those words (empty when what is unsent is an
// attachment or a queued message rather than typed text, the card then wears the mark without a new name).
export interface UnsentDraft {
    readonly id: string;
    readonly preview: string;
}

type DraftNote =
    | { readonly kind: `drafts`; readonly sandbox: string | undefined; readonly drafts: readonly UnsentDraft[] }
    // The roll-call every window posts once at load: a board that opens while the chat is already floating
    // cannot see what is in its composer, and asking is cheaper than waiting for the next keystroke.
    | { readonly kind: `roll` };

/* How much of a message becomes a card's name. Enough to tell two drafts apart at a glance and short enough to
 * sit on one line of a lane, cut at a word boundary when there is one worth cutting at. */
const PREVIEW_CHARS = 48;

export const draftPreview = (text: string): string | undefined => {
    // One line: a pasted paragraph is still a card title, and its newlines would otherwise wrap the lane.
    const line = text.trim().replace(/\s+/gu, ` `);
    if (line === ``) {
        return undefined;
    }
    if (line.length <= PREVIEW_CHARS) {
        return line;
    }
    const cut = line.slice(0, PREVIEW_CHARS);
    const space = cut.lastIndexOf(` `);
    // A word boundary in the back half only: cutting at the first space of a long word would leave a title of
    // two letters, which says less than the clipped word does.
    return `${(space > PREVIEW_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

const channel = typeof window === `undefined` || window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.chat-drafts`);

const post = (note: DraftNote): void => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
    channel?.postMessage(note);
};

const shows = showsPanel(`chat`);

// What another window last said it was holding. A snapshot, never a patch: the last note wins, the same
// presence pattern the agent roster follows.
const heard = shallowRef<ReadonlyMap<string, string>>(new Map());
const NOTHING: ReadonlyMap<string, string> = new Map();

/** The unsent drafts this window is NOT holding: what the board joins against. Empty whenever this window draws
 *  the chat itself, since then its own conversations are the answer and an echo could only be a stale copy. */
export const elsewhereDrafts: ComputedRef<ReadonlyMap<string, string>> = computed(() => (shows.value ? NOTHING : heard.value));

// The last thing this window published, so a roll-call can be answered without waiting for a keystroke.
let published: readonly UnsentDraft[] = [];

/** Say what this window's composers are holding. Called by the tab store on every change, and a no-op for a
 *  window that has never had anything to say: a fresh window announcing "nothing unsent" would otherwise
 *  retract a note the window that actually holds the chat published a moment before. */
export const publishDrafts = (drafts: readonly UnsentDraft[]): void => {
    if (drafts.length === 0 && published.length === 0) {
        return;
    }
    published = drafts;
    post({ kind: `drafts`, sandbox: useSandbox().activeSandboxId.value, drafts });
};

/** Another window's note, arriving here: the one way in, so a test hands one over by the path the channel
 *  uses (the seam summon.ts keeps for the same reason). */
export const receiveDraftNote = (note: DraftNote): void => {
    if (note.kind === `roll`) {
        if (shows.value && published.length > 0) {
            post({ kind: `drafts`, sandbox: useSandbox().activeSandboxId.value, drafts: published });
        }
        return;
    }
    // Another sandbox's chats are not this board's business, the same guard a summons keeps.
    if (note.sandbox !== useSandbox().activeSandboxId.value) {
        return;
    }
    heard.value = new Map(note.drafts.map((draft) => [draft.id, draft.preview]));
};

channel?.addEventListener(`message`, (event: MessageEvent<DraftNote>) => receiveDraftNote(event.data));

if (channel !== undefined) {
    post({ kind: `roll` });
}
