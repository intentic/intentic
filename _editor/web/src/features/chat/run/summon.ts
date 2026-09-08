import { onChatNote, postChatNote } from "./chatChannel";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { claimClosedDrafts } from "../drafts/closedDrafts";
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
    reveal(summons);
};

// What a summons logs to the focus trace: the one tab-list change no local gesture explains.
const traced = (summons: Summons): Record<string, unknown> => {
    if (summons.kind === `reveal`) {
        return { kind: summons.kind, verb: summons.verb, focus: summons.focus };
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

// One summons reader per window; a hot-reloaded rerun would apply board clicks to a stale copy of the tab store.
reloadOnHotUpdate(import.meta);
