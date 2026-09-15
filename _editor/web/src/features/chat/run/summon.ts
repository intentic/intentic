import { onChatNote, postChatNote } from "./chatChannel";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { claimClosedDrafts } from "../drafts/closedDrafts";
import { drawsChat } from "./chatEcho";
import { floatingWindowPanel, raiseFloating } from "../../../shell/window/floating";
import { Conversation } from "../session/conversation";
import { traceFocus } from "./focusTrace";
import { showRun } from "./chatRun";
import { snapshotTab, type StoredTab } from "../tabs/tabSnapshot";
import { closeConversations, keepChat } from "../tabs/useChat-tabs";
import { type Reveal, reveal, type RevealEntry } from "../panel/useChat-reveal";

// How a surface outside the panel changes the chat everywhere: the same reveal applies locally and posts to every
// window, since panel tab state is per window while everything else converges through the daemon. Portable snapshots
// ride the wire, never live objects or queued messages (which must send once); an in-panel gesture relays only what it
// selected, not the act itself.

export type Summons =
    | ({ readonly kind: `reveal` } & Reveal)
    // Carries only the run's id; each window's panel follows it from its own ledger reads.
    | { readonly kind: `run`; readonly runId: string }
    // Closes the conversation a card stands for, everywhere, words included — the board's × is the card itself going,
    // unlike the panel's own × which only narrows a pane and sets words aside.
    | { readonly kind: `close`; readonly conversationIds: readonly string[] }
    // Promotes a peeked tab from the board press, since the panel holding it (and the sweep that would otherwise
    // reclaim it) is very often another window's.
    | { readonly kind: `keep`; readonly conversationIds: readonly string[] };

const portable = (entry: RevealEntry): RevealEntry => (entry instanceof Conversation ? { ...snapshotTab(entry), queued: [] } : entry);

// Same rule as portable: the message and its files ride back, queued sends don't.
const carried = (tab: StoredTab): StoredTab => ({ ...tab, queued: [] });

/** The wire form: live conversations become portable snapshots, queued messages stripped. */
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
    if (summons.kind === `keep`) {
        for (const id of summons.conversationIds) {
            keepChat(id);
        }
        return;
    }
    const focused = reveal(summons);
    // Only the window holding the chat's own window sends a carried turn: every window applies this summons, and the
    // one that composed it kept the turn for itself unless it draws no chat (summonTurn).
    if (summons.deliver !== undefined && focused !== undefined && floatingWindowPanel.value === `chat`) {
        void focused.enqueue(summons.deliver);
    }
};

// What a summons logs to the focus trace: the one tab-list change no local gesture explains.
const traced = (summons: Summons): Record<string, unknown> => {
    if (summons.kind === `reveal`) {
        // `carries` says a first turn rode along, the one summons whose effect is a turn rather than a tab.
        return { kind: summons.kind, verb: summons.verb, focus: summons.focus, ...(summons.deliver === undefined ? {} : { carries: true }) };
    }
    return summons.kind === `run` ? { kind: summons.kind, run: summons.runId } : { kind: summons.kind, ids: summons.conversationIds.join(`,`) };
};

// Applies another window's summons to this window's own panel regardless of whether it's on screen, keeping a shadowed
// strip current for when the panel returns.
onChatNote(`summons`, (note) => {
    traceFocus(`summons`, traced(note.summons));
    apply(note.summons);
});

// Tells other windows about a gesture the panel already performed on itself (a rail click), rather than re-applying it:
// the panel alone knows whether it offers panes or which row anchored a range, so re-running the reveal here would be a
// second, possibly different, answer.
export const relaySummons = (summons: Summons): void => {
    postChatNote({ kind: `summons`, summons: wireSummons(summons) });
};

// Claims closed-chat drafts once, here, for both the local apply and the broadcast to share: the drafts store answers
// only the first window to ask, so claiming separately in each left the actual conversation (often in another window)
// claiming nothing.
export const claimedSummons = (summons: Summons): Summons =>
    summons.kind === `reveal` ? { ...summons, unsent: claimClosedDrafts(summons.entries.map((entry) => entry.conversationId)) } : summons;

// A BroadcastChannel never delivers to its own poster, so the local apply plus the broadcast are what make every
// window, this one included, run the identical reveal.
export const summonChat = (summons: Summons): void => {
    const carrying = claimedSummons(summons);
    apply(carrying);
    relaySummons(carrying);
};

/**
 * Shows a chat everywhere and starts its first turn, the one act behind every "start an agent for me" button.
 *
 * The turn runs in the window drawing the chat, never necessarily the one that was clicked: a turn started from a
 * window with no chat on screen would run where nobody can watch it, keep its error where nobody can read it, and die
 * with that window (a reload takes the composed prompt with it, and the daemon never hears of the press). Pressed
 * from such a window, the prompt rides the summons and the chat's own window sends it, raised so the answer is where
 * the eye already goes.
 */
export const summonTurn = (conversation: Conversation, prompt: string): void => {
    const here = drawsChat.value;
    summonChat({
        kind: `reveal`,
        verb: `show`,
        entries: [conversation],
        focus: conversation.conversationId,
        caret: true,
        ...(here ? {} : { deliver: prompt }),
    });
    if (here) {
        void conversation.enqueue(prompt);
        return;
    }
    // Raises the window already holding the chat, so the answer arrives where the eye goes; never opens one.
    raiseFloating(`chat`);
};

// One summons reader per window; a hot-reloaded rerun would apply board clicks to a stale copy of the tab store.
reloadOnHotUpdate(import.meta);
