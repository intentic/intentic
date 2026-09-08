import { open, rename, resumeHeldTurn, setAutoLand, setMoveAfterLimit, setResumeAfterLimit, setResumeAfterOutage, stopWatching } from "./useAgents-actions";
import { archive, archivedFlash, busyIds, dismissNotice, notice, purgeArchived, restore, undoable, undoArchive } from "./useAgents-archive";
import { agentById, attention, blocking, fleet, forgetFleet, lanes, unread } from "./useAgents-fleet";
import { archived, archiveLoading, desyncRegistry, heldWakes, loadArchived, markAllSeen, markSeen, refresh, releaseHeld } from "./useAgents-registry";

// Fleet store: the daemon's agent registry mirrored into the browser, merged with open Conversation tabs by
// conversationId. Module-level singleton, like useChat.
//
// Four topic modules, each depending only downward:
// - useAgents-registry: roster/archived list, revisions, pending moves, held wakes
// - useAgents-fleet: registry/tab/draft merge into cards, lanes, counts
// - useAgents-archive: archive/restore/purge/undo, busy cards
// - useAgents-actions: per-agent writes, open
//
// This file assembles them and owns the reset that touches all four.

// Drops everything tied to a particular daemon: registry state, the fleet's cached-card memo, undo offers, and the
// error strip's ids and revision line.
const desync = (keepRoster: boolean): void => {
    desyncRegistry(keepRoster);
    forgetFleet();
    undoable.value = [];
    notice.value = undefined;
};
export const resetAgents = (): void => desync(false);
// The disconnect flavor: stale-while-reconnecting.
export const desyncAgents = (): void => desync(true);

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
        setResumeAfterOutage,
        setResumeAfterLimit,
        setMoveAfterLimit,
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
