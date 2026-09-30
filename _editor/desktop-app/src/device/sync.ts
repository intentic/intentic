import { t } from "@intentic/ui/i18n";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { computed, ref } from "vue";
import { track } from "../analytics";
import { folderEntries, setupAlert, syncRun, takePendingSync, workspaceOpen, type SyncArgs } from "../desktop";
import { linesOf, running, runOutcome, start } from "./runs";

// DESKTOP SYNC, ENABLED FROM A SYSTEM DIALOG: the workspace's Desktop sync card hands its enrollment over
// (`intentic://sync`), since a webview can't pick a folder itself, and this runs the same sync.sh or sync.ps1 the card's
// one-liner does. The card polls, and flips to "Enabled" once this finishes.

/** An enrollment on This device: what it was handed, the folder picked, and what stopped it, if anything did. */
export interface SyncEnrollment {
    readonly args: SyncArgs;
    readonly dir?: string;
    readonly error?: string;
}

export const syncSetup = ref<SyncEnrollment | undefined>(undefined);
export const syncLines = computed(() => linesOf(`sync-setup`));

const enrollment = (args: SyncArgs, dir: string | undefined, error?: string): SyncEnrollment => {
    const held: SyncEnrollment = dir === undefined ? { args } : { args, dir };
    return error === undefined ? held : { ...held, error };
};

const runSync = async (args: SyncArgs, dir: string | undefined): Promise<void> => {
    syncSetup.value = enrollment(args, dir);
    const startedAt = Date.now();
    track(`desktop_sync_started`, { mirror: args.mirror, takeover: args.takeover });
    const failure = await start(`sync-setup`, () => syncRun(args, dir));
    track(`desktop_sync_finished`, { mirror: args.mirror, takeover: args.takeover, ...runOutcome(`sync-setup`, failure === undefined, startedAt) });
    if (failure === undefined) {
        syncSetup.value = undefined;
        // Returns to the page whose card is already polling for this enrollment.
        await workspaceOpen();
        return;
    }
    syncSetup.value = enrollment(args, dir, failure);
    // Same courtesy as a failed install: a stopped run must not go unnoticed in an unwatched window.
    await setupAlert();
};

// What the folder already holds, for the warning: a folder that couldn't be read is said as unread, never as empty,
// since the count is the warning's only evidence.
const heldIn = async (folder: string): Promise<string> => {
    try {
        const entries = await folderEntries(folder);
        return entries === 0 ? `` : `\n\n${t(`desktop.device.folderHolds`, { count: entries }, entries)}`;
    } catch (error) {
        return `\n\n${t(`desktop.device.folderUnread`, { error: String(error) })}`;
    }
};

// The folder, from the system's dialog; nothing for a cancelled one or an answer that names no single folder.
const pickFolder = async (what: string): Promise<string | undefined> => {
    const picked = await open({ directory: true, multiple: false, title: t(`desktop.app.chooseFolderToKeep`, { what }) });
    return picked === null || Array.isArray(picked) || picked === `` ? undefined : picked;
};

/** The enrollment the app parked for this window, taken (its pairing token is single-use), asked about, then run. */
export const drainSync = async (): Promise<void> => {
    const args = await takePendingSync();
    if (args === null || running.value) {
        return;
    }
    // A mirror pairing syncs no folder: nothing to pick and nothing to warn about.
    if (args.mirror) {
        await runSync(args, undefined);
        return;
    }
    const what = args.name ?? t(`desktop.app.yourSandbox`);
    const picked = await pickFolder(what);
    // Cancelled, or answered no: nothing ran, so the reader goes back to the card that asked. Sync is two-way with no
    // undo, which is why it is asked at all.
    const agreed =
        picked !== undefined &&
        (await confirm(`${picked}\n\n${t(`desktop.device.syncsBothWays`, { what })}${await heldIn(picked)}`, {
            title: t(`desktop.app.keepFolderInSync`, { what }),
            kind: `warning`,
            okLabel: t(`desktop.device.startSyncing`),
        }));
    if (!agreed) {
        await workspaceOpen();
        return;
    }
    await runSync(args, picked);
};

// Re-runs with the folder already chosen and the same pairing: a sandbox takes a redeemed pairing again from the machine
// key that redeemed it, for the pairing's ten minutes (desktop-sync.routes.ts), so a run that failed after enrolling
// enrolls again. An older sandbox spent it on first use, and one past its ten minutes needs the card's Regenerate.
export const retrySync = async (): Promise<void> => {
    const held = syncSetup.value;
    if (held === undefined || running.value) {
        return;
    }
    await runSync(held.args, held.dir);
};

export const dismissSync = (): void => {
    syncSetup.value = undefined;
};
