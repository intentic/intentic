import { onChatNote, postChatNote } from "./chatChannel";
import { reloadOnHotUpdate } from "../hotReload";
import { claimClosedDrafts } from "./closedDrafts";
import { Conversation } from "./conversation";
import { traceFocus } from "./focusTrace";
import { showRun } from "./chatRun";
import { snapshotTab, type StoredTab } from "./tabSnapshot";
import { closeConversations, type Reveal, reveal, type RevealEntry } from "./useChat";

/* SUMMONING THE CHAT, FOR EVERY WINDOW AT ONCE, the one way a surface outside the panel puts something on it.
 *
 * The app runs as a full copy per browser window, and the copies share nothing but the daemon: agents,
 * transcripts and rosters converge everywhere, while the chat panel's own state, which tabs are open, which is
 * focused, is deliberately per window. The chat's own floating window is one of those copies
 * (composables/floating.ts), so a board click that only mutated the clicking window's store was invisible out
 * there: "I pressed New agent and the floating chat kept showing an old conversation" was this, and nothing
 * else.
 *
 * So a summons is not a store call, it is a BROADCAST: the same reveal (useChat.reveal) is applied in this
 * window and posted to every other window of this origin (chatChannel.ts), each of which applies it to its own
 * panel, docked, floating, or parked. One channel, one apply, no ownership question: there is no "attached"
 * window to find and no fallback when it is missing, because every window is told and every window obeys.
 *
 * WHAT RIDES THE CHANNEL is the portable description of a tab (StoredTab), never the live object: a window
 * that has never heard of the chat rebuilds it exactly as a reload would and hydrates it from the daemon. Two
 * things deliberately do NOT ride it:
 *   · queued messages, user-written turns waiting to be SENT. A copy of those in another window would be
 *     sent again by that window's own queue drain: acts happen once, in the window that was pressed; the
 *     resulting turn reaches everyone through the daemon.
 *   · gestures INSIDE the panel, its rail, its tabs, its pane ×. A gesture on the panel acts on the panel it
 *     was made in: the reader is pointing at the thing itself, so there is nothing to route. What such a
 *     gesture does do is SAY what it pointed at, once it has acted (relaySummons, at the foot of this file):
 *     the fleet board rings whatever the chat is showing, and it is a whole window away.
 *
 * Scoped by SANDBOX, because the summons names conversations of one sandbox's daemon: a window looking at
 * another sandbox has no such chats and the channel drops it before it gets here. */

export type Summons =
    | ({ readonly kind: `reveal` } & Reveal)
    // A workflow run taken into the panel: every window's panel follows the run from its own ledger reads
    // (ChatPanel's follower), so the summons carries the run's id and nothing else.
    | { readonly kind: `run`; readonly runId: string }
    /* THE OTHER HALF OF A BOARD CARD: closing the CONVERSATION it stands for, everywhere, the same way opening
     * it shows it everywhere. A card is not a tab of the window it is drawn in — it is the conversation, seen
     * from the board — so its × closing only the pressed window's copy came out wrong exactly where the reveal
     * did: with the chat POPPED OUT, the press on the board shut an invisible shadow of it while the floating
     * window went on showing the chat. And because it is the conversation going rather than a surface's view of
     * it, the words unsent in it go too (useChat.closeConversations): one press, on a card whose mark says so.
     *
     * The panel's OWN × is untouched and still local (ChatTabList): a gesture on the strip narrows the strip it
     * was made in and sets the words aside, which is the rule this is the other side of, not an exception to. */
    | { readonly kind: `close`; readonly conversationIds: readonly string[] };

const portable = (entry: RevealEntry): RevealEntry => (entry instanceof Conversation ? { ...snapshotTab(entry), queued: [] } : entry);

// The same rule for the words a reopened chat brings back with it (closedDrafts): the message, its age and its
// staged files ride, the QUEUED turns do not. Those are sends waiting to happen, and they happen once, in the
// window that was pressed.
const carried = (tab: StoredTab): StoredTab => ({ ...tab, queued: [] });

/** The wire form: live conversations fold into their portable snapshots, queued messages stripped (see above). */
export const wireSummons = (summons: Summons): Summons =>
    summons.kind === `reveal` ? { ...summons, entries: summons.entries.map(portable), unsent: summons.unsent?.map(carried) } : summons;

const apply = (summons: Summons): void => {
    if (summons.kind === `run`) {
        showRun(summons.runId, `live`);
        return;
    }
    if (summons.kind === `close`) {
        closeConversations(new Set(summons.conversationIds));
        return;
    }
    reveal(summons);
};

// What a summons says about itself in the focus trace: a tab list that changed because ANOTHER window was
// clicked is the one movement no local gesture explains, so it says where it came from.
const traced = (summons: Summons): Record<string, unknown> => {
    if (summons.kind === `reveal`) {
        return { kind: summons.kind, verb: summons.verb, focus: summons.focus };
    }
    return summons.kind === `run` ? { kind: summons.kind, run: summons.runId } : { kind: summons.kind, ids: summons.conversationIds.join(`,`) };
};

// Another window's summons, arriving here, applied to this window's own panel, whether that panel is on screen
// or not: a window that is not drawing the chat keeps its copy of the strip current as the surface its own
// actions run on (useChat's note on the shadow), and takes the real strip back from the seed when the panel
// returns.
onChatNote(`summons`, (note) => {
    traceFocus(`summons`, traced(note.summons));
    apply(note.summons);
});

/* TELL THE OTHER WINDOWS, WITHOUT PERFORMING IT HERE, for a gesture that has ALREADY acted on the panel it was
 * made in: the panel's own rail and tabs (ChatTabList).
 *
 * The rule above about panel gestures not being routed was right about the ACT and wrong about the SELECTION.
 * A click on a rail row points the chat at a conversation, and the fleet board draws a ring around whatever the
 * chat is pointing at, so a rail click in the popped-out window left the board ringing the chat before it: two
 * surfaces on two screens disagreeing about which conversation the user is in, with the board's answer being
 * the stale one. The board's own clicks had always been broadcast, so the disagreement was one-way, which is
 * the worst kind, everything looked wired up until you clicked on the side that wasn't.
 *
 * Told rather than performed because the panel has already done its half, with the rules only it knows (whether
 * this surface offers panes at all, which row was the anchor of a range). Re-running the reveal over that would
 * be a second answer to a question the panel has already answered. */
export const relaySummons = (summons: Summons): void => {
    postChatNote({ kind: `summons`, summons: wireSummons(summons) });
};

/* THE SUMMONS AS IT GOES OUT, HOLDING THE WORDS ITS CHATS WERE CLOSED WITH (closedDrafts). Claimed here, once,
 * by the window whose gesture reopens them, and then carried, because that store answers the FIRST window to ask
 * and every window applies the same reveal.
 *
 * Letting each of them ask for itself is what the first cut did, and it lost the message it was written to save.
 * The press is on the BOARD; summonChat applies locally before it broadcasts; so the board's window claimed the
 * words into a conversation of its own — and when the chat is POPPED OUT that window draws no chat at all, while
 * the floating one, the only place the user could see the message, rebuilt the tab from a store already empty.
 *
 * Its own function because the guarantee is that the local apply and the broadcast are handed the SAME claim,
 * never two, and that is the thing worth being able to read on its own (wireSummons is exported for its half of
 * the same reason). */
export const claimedSummons = (summons: Summons): Summons =>
    summons.kind === `reveal` ? { ...summons, unsent: claimClosedDrafts(summons.entries.map((entry) => entry.conversationId)) } : summons;

// Apply here, tell everyone else, a BroadcastChannel does not deliver to its own poster, so the local apply
// and the broadcast together are what make every window (this one included) run the identical reveal.
export const summonChat = (summons: Summons): void => {
    const carrying = claimedSummons(summons);
    apply(carrying);
    relaySummons(carrying);
};

// One summons reader per window: a hot update that re-ran this module would apply every board click to a
// second copy of the tab store, and the panel would sit there ignoring the board (hotReload.ts).
reloadOnHotUpdate(import.meta);
