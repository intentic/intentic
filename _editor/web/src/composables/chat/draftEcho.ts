import { computed, type ComputedRef, shallowRef, watch } from "vue";
import { floatingWindowPanel, showsPanel } from "../floating";
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
 * So when the chat floats, the window that HOLDS it publishes, on a channel of its own, which conversations
 * hold unsent words and the first few of them. Every other window joins its board against that. Two rules keep
 * it honest:
 *   · only the window POSITIVELY holding the floating chat speaks. A regular window briefly believes it draws
 *     every panel while booting, before the holder's roll-call arrives, so `showsPanel` is not proof of
 *     ownership and letting it publish makes a half-restored strip overwrite the real one;
 *   · the holder's FIRST snapshot is published even when empty. A reload is a new JS realm, so suppressing its
 *     empty snapshot leaves the last realm's non-empty note alive on every dashboard: the stale "Unsent
 *     message" badge whose chat opens onto an empty composer.
 * A window drawing the docked chat reads its own conversations and ignores every echo, so docked chats need no
 * publisher at all and no stale note can outrank the composer itself.
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

/** THE OTHER HALF OF THAT RULE, and the one every reader outside this module has to apply for itself: exactly
 *  one window speaks for a composer, so while the chat is drawn somewhere else this window's OWN conversations
 *  are the stale copy and the echo above is the only account worth believing.
 *
 *  A window that stops drawing the chat forgets its STORED strip (useChat's snapshot watch) but keeps the tab
 *  objects it already built, frozen with whatever was in their composers at the moment the panel left. A reader
 *  that took the UNION of the two halves therefore latched those words permanently: the send happened out in the
 *  floating window, which cleared its own mark and published an empty snapshot, while the dashboard went on
 *  wearing "Unsent message" for a message that no longer existed anywhere. Nothing can retract a local draft in a
 *  window whose composer the user cannot reach.
 *
 *  It reads optimistically during boot (`showsPanel`: a window believes it draws every panel until a holder's
 *  first beat arrives), which is the right way round for this: an unproven window answers from its own tabs,
 *  exactly as it did before the chat moved, and switches to the echo the moment the holder speaks. */
export const drawsChat: ComputedRef<boolean> = shows;

// The latest snapshot this window could publish, so taking ownership and a roll-call can both answer without
// waiting for a keystroke. It is filled before the floating route claims the panel during boot.
let published: readonly UnsentDraft[] = [];

/** Say what this window's composers are holding. Called by the tab store on every change. Every window keeps
 *  its latest snapshot, but only the floating chat's proven holder puts one on the wire. */
export const publishDrafts = (drafts: readonly UnsentDraft[]): void => {
    published = drafts;
    if (floatingWindowPanel.value === `chat`) {
        post({ kind: `drafts`, sandbox: useSandbox().activeSandboxId.value, drafts });
    }
};

// The floating route claims the panel after this module and the tab store have booted. That positive ownership
// transition publishes the restored snapshot immediately, INCLUDING empty: it retracts any note left by the
// previous realm when this window is a reload of the floating chat.
watch(floatingWindowPanel, (panel) => {
    if (panel === `chat`) {
        post({ kind: `drafts`, sandbox: useSandbox().activeSandboxId.value, drafts: published });
    }
});

/** Another window's note, arriving here: the one way in, so a test hands one over by the path the channel
 *  uses (the seam summon.ts keeps for the same reason). */
export const receiveDraftNote = (note: DraftNote): void => {
    if (note.kind === `roll`) {
        if (floatingWindowPanel.value === `chat`) {
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
