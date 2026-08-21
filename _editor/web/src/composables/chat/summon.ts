import { Conversation } from "./conversation";
import { traceFocus } from "./focusTrace";
import { showRun } from "./chatRun";
import { snapshotTab } from "./tabSnapshot";
import { type Reveal, reveal, type RevealEntry } from "./useChat";
import { useSandbox } from "../sandbox/useSandbox";

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
 * window and posted to every other window of this origin, each of which applies it to its own panel, docked,
 * floating, or parked. One channel, one apply, no ownership question: there is no "attached" window to find
 * and no fallback when it is missing, because every window is told and every window obeys.
 *
 * WHAT RIDES THE CHANNEL is the portable description of a tab (StoredTab), never the live object: a window
 * that has never heard of the chat rebuilds it exactly as a reload would and hydrates it from the daemon. Two
 * things deliberately do NOT ride it:
 *   · queued messages, user-written turns waiting to be SENT. A copy of those in another window would be
 *     sent again by that window's own queue drain: acts happen once, in the window that was pressed; the
 *     resulting turn reaches everyone through the daemon.
 *   · gestures INSIDE the panel, its rail, its tabs, its pane ×. A gesture on the panel acts on the panel it
 *     was made in: the reader is pointing at the thing itself, so there is nothing to route.
 *
 * Scoped by SANDBOX, because the summons names conversations of one sandbox's daemon: a window looking at
 * another sandbox has no such chats and quietly ignores it. Same-origin only (a BroadcastChannel's own scope),
 * which is also the boundary of "the same app". */

export type Summons =
    | ({ readonly kind: `reveal` } & Reveal)
    // A workflow run taken into the panel: every window's panel follows the run from its own ledger reads
    // (ChatPanel's follower), so the summons carries the run's id and nothing else.
    | { readonly kind: `run`; readonly runId: string };

// The wire form: live conversations fold into their portable snapshots, queued messages stripped (see above).
export type WireSummons = { readonly sandbox: string | undefined } & Summons;

const portable = (entry: RevealEntry): RevealEntry => (entry instanceof Conversation ? { ...snapshotTab(entry), queued: [] } : entry);

export const wireSummons = (summons: Summons): WireSummons => ({
    sandbox: useSandbox().activeSandboxId.value,
    ...(summons.kind === `reveal` ? { ...summons, entries: summons.entries.map(portable) } : summons),
});

const apply = (summons: Summons): void => {
    if (summons.kind === `run`) {
        showRun(summons.runId, `live`);
        return;
    }
    reveal(summons);
};

// Another window's summons, arriving here, the channel's receiving half, named so a test can hand it a wire
// message without a second window to post one.
export const receiveSummons = (summons: WireSummons): void => {
    if (summons.sandbox !== useSandbox().activeSandboxId.value) {
        return;
    }
    // The other end of the focus trace: a focus that moves because ANOTHER window was clicked is the one
    // movement no local gesture explains, so it says where it came from.
    traceFocus(
        `summons`,
        summons.kind === `reveal` ? { kind: summons.kind, verb: summons.verb, focus: summons.focus } : { kind: summons.kind, run: summons.runId },
    );
    apply(summons);
};

// One channel per window, listening from the first import. Guarded like the auth channels: a runtime without
// BroadcastChannel (tests, SSR) just has a single-window app, which is exactly what no channel means.
const channel = typeof window === `undefined` || window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.chat-summons`);

channel?.addEventListener(`message`, (event: MessageEvent<WireSummons>) => receiveSummons(event.data));

// Apply here, tell everyone else, a BroadcastChannel does not deliver to its own poster, so the local apply
// and the broadcast together are what make every window (this one included) run the identical reveal.
export const summonChat = (summons: Summons): void => {
    apply(summons);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
    channel?.postMessage(wireSummons(summons));
};
