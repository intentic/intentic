import { open, rename, resumeHeldTurn, setAutoLand, setBreakPolicy, stopWatching } from "./useAgents-actions";
import { archive, archivedFlash, busyIds, dismissNotice, notice, purgeArchived, restore, undoable, undoArchive } from "./useAgents-archive";
import { agentById, attention, blocking, fleet, forgetFleet, lanes, unread } from "./useAgents-fleet";
import { archived, archiveLoading, desyncRegistry, heldWakes, loadArchived, markAllSeen, markSeen, refresh, releaseHeld } from "./useAgents-registry";

// Fleet store: the daemon's agent registry mirrored into the browser, merged with open Conversation tabs by
// conversationId. Module-level singleton, like useChat.
//
// Five topic modules, each depending only downward:
// - useAgents-registry: roster/archived list, revisions, pending moves, held wakes
// - useAgents-provisional: what this browser's presses say a card is until the roster catches up
// - useAgents-fleet: registry/tab/draft merge into cards, lanes, counts
// - useAgents-archive: archive/restore/purge/undo, busy cards
// - useAgents-actions: per-agent writes, open
//
// This file assembles them and owns the disconnect that touches all five; a sandbox switch drops all five's state with
// the scope instead.

// Stale-while-reconnecting: drops the revision line, the fleet's cached-card memo, undo offers and the error strip, and
// keeps the painted roster and the presses' claims, which outlive a mere disconnect since the roster does too.
export const desyncAgents = (): void => {
    desyncRegistry();
    forgetFleet();
    undoable.value = [];
    notice.value = undefined;
};

export function useAgents() {
    return {
        fleet,
        lanes,
        attention,
        blocking,
        unread,
        heldWakes,
        releaseHeld,
        refresh,
        open,
        markSeen,
        markAllSeen,
        rename,
        setAutoLand,
        setBreakPolicy,
        resumeHeldTurn,
        stopWatching,
        agentById,
        archived,
        archiveLoading,
        loadArchived,
        archive,
        restore,
        purgeArchived,
        undoArchive,
        undoable,
        archivedFlash,
        notice,
        dismissNotice,
        busyIds,
    };
}
