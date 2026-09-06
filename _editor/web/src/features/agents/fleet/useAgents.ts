import { open, rename, resumeHeldTurn, setAutoLand, setResumeAfterLimit, setResumeAfterOutage, stopWatching } from "./useAgents-actions";
import { archive, archivedFlash, busyIds, dismissNotice, notice, purgeArchived, restore, undoable, undoArchive } from "./useAgents-archive";
import { agentById, attention, blocking, fleet, forgetFleet, lanes, unread } from "./useAgents-fleet";
import { archived, archiveLoading, desyncRegistry, heldWakes, loadArchived, markAllSeen, markSeen, refresh, releaseHeld } from "./useAgents-registry";

/* The fleet store, the daemon's agent registry mirrored into the browser. Fed two ways: the /events stream's
 * `agents` roster snapshots (last frame wins, the presence pattern, see useSandboxLiveness) and an explicit
 * refresh() from GET /agents on the reachable seam. The FLEET view merges the registry (authoritative:
 * status/branch/cost, agents this tab never opened) with the open Conversation tabs by conversationId (live:
 * in-browser streaming state). Module-level singleton, like useChat.
 *
 * The store is four topic modules that depend strictly downward, so any one of them loads on its own:
 *   useAgents-registry  the roster and the archived list as the daemon reports them, revisioned snapshots,
 *                       pending moves, held wakes, the reads and optimistic marks that keep them true
 *   useAgents-fleet     FleetAgent, the registry/tab/draft merge into cards, the lanes, the counts
 *   useAgents-archive   archive, restore, purge and undo, what each of them says, and which cards are busy
 *   useAgents-actions   per-agent writes (rename, postures, a held turn resumed, a watch dropped) and open
 * This file is what the components call, and the one reset that has to reach all four. */

/* Drop everything that is a promise to a PARTICULAR daemon. The registry's own part (the revision line, pending
 * moves, and depending on `keepRoster` the painted roster and held wakes) is argued at desyncRegistry; the fleet's
 * memo goes with the roster it cached cards from, and the undo offers and the error strip are promises about ids
 * and revision lines the next daemon may never have heard of. */
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
