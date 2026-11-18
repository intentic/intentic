import { type Ref, ref } from "vue";
import { type LocalRoster, localHost } from "../../../app/environments/localHost";

// THE APP'S RECORD OF THE ACCOUNT'S SANDBOXES, ONE COPY PER LOCAL WINDOW (2026-11-18). What the workspace last told the
// app (localHost.ts `roster`): its sandboxes in the switcher's order, names and small logos included. A local window's
// rail draws them from the first paint while the platform's own list is still on its way (local/LocalMasterRail.vue), and
// orders that list by them once it lands (switcherPlace.ts `arranged`). Read before the window mounts (main.ts), since the
// first press on This computer from the workspace builds this window and swaps it in as soon as its bar is up
// (the app's windows.rs `when_drawn`): until then the unrolled rail came up with no sandbox on it, every tile the
// workspace's rail had just shown gone, and back a moment later when the platform answered.

// allow(module-state): the local window's one copy of the app's record, read at the start and on each unrolling
const held = ref<LocalRoster | undefined>(undefined);
// allow(module-state): the read made as the window starts, which main.ts waits on before mounting
let first: Promise<LocalRoster | undefined> | undefined;

/** The app's record as last read; undefined before any read has answered. */
export const heldLocalRoster: Readonly<Ref<LocalRoster | undefined>> = held;

/** Reads the app's record again, and holds what it answers. */
export const readLocalRoster = async (): Promise<LocalRoster> => {
    const roster = await localHost().roster();
    held.value = roster;
    return roster;
};

/** The read the window starts with, made once: undefined when it failed, which the console is told. */
export const localRosterAtStart = (): Promise<LocalRoster | undefined> =>
    (first ??= readLocalRoster().catch((error) => {
        console.warn(`[local] the workspace's sandboxes could not be read:`, error);
        return undefined;
    }));

/** Forgets what was read: a test's window starts with nothing read. */
export const resetLocalRoster = (): void => {
    held.value = undefined;
    first = undefined;
};
