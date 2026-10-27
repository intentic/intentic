import type { RosterFrames } from "@intentic/sandbox-contract/events/system-events";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";

// How the fleet roster goes out: who listens, the revision line each send is tagged with, and the window running turns'
// progress waits in. A listener that asked for changes takes a send only progress raised as the cards it moved, since
// building every card for every window on every tool call made the roster the daemon's costliest send.

// One roster send as a listener hears it: the whole live roster (`whole`), or only the cards running turns moved since
// the send before, which only a listener that asked for changes is handed.
export type RosterListener = (agents: AgentSummary[], rev: number, whole: boolean) => void;

export interface RosterSends {
    // An immediate whole roster at the current revision, then every send; answers the unsubscribe.
    readonly subscribe: (listener: RosterListener, frames?: RosterFrames) => () => void;
    // A change someone made, out at once and whole to everyone.
    readonly broadcast: () => void;
    // A running turn moved this conversation's card; out within the window.
    readonly progress: (id: string) => void;
    readonly revision: () => number;
}

// What a send reads off the registry: the live roster whole, and the cards of these conversations still on the board.
export interface RosterSource {
    readonly list: () => AgentSummary[];
    readonly cardsOf: (ids: readonly string[]) => AgentSummary[];
}

export const rosterSends = (source: RosterSource, windowMs: number): RosterSends => {
    const listeners = new Map<RosterListener, RosterFrames>();
    // Bumped once per published change, at the change, not the send; see `revision` on AgentsRegistry.
    let revision = 0;
    // When the roster last went out, and the send a burst is waiting on.
    let sentAt = Number.NEGATIVE_INFINITY;
    let sending: ReturnType<typeof setTimeout> | undefined;
    // Conversations whose progress moved their card since the last send: the whole of what that send hands a listener
    // that asked for changes.
    const moved = new Set<string>();

    // Only progress asked for this send when `progressed`, so a listener that asked for changes is handed just the cards
    // that moved; any other send could have moved or removed any card, and goes whole to everyone. Each answer is built
    // once and shared, and the whole roster not at all when no listener takes it.
    const send = (progressed: boolean): void => {
        sending = undefined;
        sentAt = Date.now();
        const ids = [...moved];
        moved.clear();
        let roster: AgentSummary[] | undefined;
        let changed: AgentSummary[] | undefined;
        for (const [listener, frames] of listeners) {
            if (progressed && frames === "changes") {
                changed ??= source.cardsOf(ids);
                listener(changed, revision, false);
            } else {
                roster ??= source.list();
                listener(roster, revision, true);
            }
        }
    };

    return {
        subscribe: (listener, frames = "snapshots") => {
            listeners.set(listener, frames);
            // Carries the current revision without bumping it; subscribing is not a change, and a bumped one would look
            // newer than already-applied rosters.
            listener(source.list(), revision, true);
            return () => listeners.delete(listener);
        },
        // Carries whatever progress was waiting. The revision is bumped at the change, not the send, so a route reading
        // `revision()` right after gets the one its own change produced.
        broadcast: () => {
            revision += 1;
            clearTimeout(sending);
            send(false);
        },
        // Every running turn's tool calls, usage and todos land here. A send costs every card for a listener taking the
        // whole roster, so progress goes out at most once a window: after a quiet spell at once, the rest of a burst
        // together at the window's end.
        progress: (id) => {
            revision += 1;
            moved.add(id);
            if (sending !== undefined) {
                return;
            }
            const wait = sentAt + windowMs - Date.now();
            if (wait <= 0) {
                send(true);
                return;
            }
            sending = setTimeout(() => send(true), wait);
        },
        revision: () => revision,
    };
};
