import { errorMessage } from "@intentic/base/errors";
import { ref } from "vue";
import {
    type FolderSetup,
    folderSetupCheck,
    folderSetupDismiss,
    folderSetupEndSession,
    folderSetupRetry,
    folderSetups as readFolderSetups,
    onFolderSetups,
    revealLog,
    type SessionEnd,
} from "../desktop";

// EVERY FOLDER'S WAY TO ITS OWN SANDBOX, AS EVERY WINDOW SEES IT: the app makes each one (src-tauri/src/folder_setup.rs),
// not a window, so this is only a reading of the app's records: asked once on opening, then every change heard. A
// window draws its own folder's (host.ts), and the rail's tile spins while any is being made (badge.ts).

/** The app's records, once they have been read; undefined before. */
export const folderSetups = ref<readonly FolderSetup[] | undefined>(undefined);
// When the list held was sent: an opening read that answers after a change it predates never replaces the change.
let heldAt = 0;

const newest = (records: readonly FolderSetup[]): number => records.reduce((latest, record) => Math.max(latest, record.updatedAt), 0);

// Only a newer list replaces the one held. A change heard is always taken: the app sends the whole list on every change,
// a folder put away included, which no record's own time can show.
const take = (records: readonly FolderSetup[], heard: boolean): void => {
    const at = newest(records);
    if (folderSetups.value === undefined || heard || at > heldAt) {
        folderSetups.value = records;
        heldAt = Math.max(heldAt, at);
    }
};

/** Takes `records` as heard from the app. */
const heard = (records: readonly FolderSetup[]): void => take(records, true);

let started: Promise<void> | undefined;

/** Read the records and follow them, once per window. A failed read is the console's: the next change still arrives. */
export const startFolderSetups = (): Promise<void> =>
    (started ??= (async () => {
        await onFolderSetups(heard);
        try {
            take(await readFolderSetups(), false);
        } catch (error) {
            console.error(`[folder setups] they could not be read:`, error);
        }
    })());

/** The folder at `path` (the path its window is told) on its way to its own sandbox; none when it is not. Pure. */
export const folderSetupOf = (records: readonly FolderSetup[] | undefined, path: string | undefined): FolderSetup | undefined =>
    path === undefined ? undefined : records?.find((record) => record.path === path);

/**
 * Any folder's sandbox being made right now but the one at `path`: Devices' tile spins for it. The window on that folder
 * has a tile of its own for it beside Files (the web's local/LocalShell.vue), and two spinning for one setup said nothing
 * more than one. Pure.
 */
export const folderSetupRunningBesides = (records: readonly FolderSetup[] | undefined, path: string | undefined): boolean =>
    (records ?? []).some((record) => record.path !== path && (record.state === `creating` || record.state === `interrupted`));

// One press, rejecting with the app's sentence, which the card says under it (the shell's contract for every verb).
const attempt = async (action: () => Promise<void>): Promise<void> => {
    try {
        await action();
    } catch (error) {
        const said = errorMessage(error);
        throw new Error(said, { cause: error });
    }
};

/** THE PRESSES ON A FOLDER'S CARD, each about the calling window's own folder (host.ts `act`). */
export const folderSetupVerbs = {
    /** "Try again", or the card's go-ahead for what this computer needs first (`consent`). */
    retry: (consent = false): Promise<void> => attempt(() => folderSetupRetry(consent)),
    /** Look again now (Docker was just started). */
    check: (): Promise<void> => attempt(() => folderSetupCheck()),
    /** The restart or sign-out its setup asked of Windows. */
    endSession: (how: SessionEnd): Promise<void> => attempt(() => folderSetupEndSession(how)),
    /** The folder no longer asked for. */
    dismiss: (): Promise<void> => attempt(() => folderSetupDismiss()),
    /** Its last setup's transcript, in the file manager. */
    log: async (record: FolderSetup | undefined): Promise<void> => {
        const log = record?.logPath;
        if (log !== undefined) {
            await attempt(() => revealLog(log));
        }
    },
};
