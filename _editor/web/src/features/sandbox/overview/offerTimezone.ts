import { localZone } from "@intentic/sandbox-contract/time";
import { sandboxRpc } from "../client/sandboxRpc";
import { queryClient } from "../../../lib/queryPersistence";
import { rpcKey } from "../../../lib/queryKeys";

// A sandbox runs its daemon in a UTC container; the person setting a schedule almost never lives in one. Nothing in
// the daemon can work out where its owner is, so the browser — the one part of this system standing next to them —
// says so once, the first time a workspace is opened.
//
// An OFFER, not a setting: the route takes it only while the sandbox has no zone, so the tenth browser to open a
// workspace cannot move its chores onto its own clock, and a laptop carried to another country cannot either. Changing
// a zone already chosen is a deliberate edit on the settings screen.

let offered = false;

/**
 * Tells the sandbox which clock this browser is on, once per app session. Silent on failure: a workspace whose zone
 * could not be set still works, it just reads its schedules in UTC and says so on every screen that shows one.
 */
export const offerTimezone = async (): Promise<void> => {
    if (offered) {
        return;
    }
    offered = true;
    try {
        const state = await sandboxRpc.settings.adoptTimezone({ timezone: localZone() });
        // Only when this call is what set it: an offer the sandbox declined changed nothing, and invalidating then
        // would refetch every settings screen in every window for no new fact.
        if (state.adopted) {
            await queryClient.invalidateQueries({ queryKey: rpcKey(`settings.get`) });
        }
    } catch {
        // A daemon too old to know this route, or one not reachable yet. Neither is worth a notice: the zone is
        // visible wherever it matters, and the next app load offers again.
    }
};

/** Test seam: the once-per-session latch is module state, which a second test would otherwise inherit. */
export const resetTimezoneOffer = (): void => {
    offered = false;
};
