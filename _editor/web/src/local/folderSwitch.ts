import { nextTick } from "vue";
import { faceOf, type LocalFace, LOCAL_REPOINT_EVENT, localSandboxId, wearFace } from "../app/environments/local";
import { useSandbox } from "../client/sandbox/useSandbox";
import { landOnAfterSwitch } from "../features/sandbox/switching/sandboxScreen";
import { setPageTitle } from "../shell/browser-tab/tabTitle";

// ANOTHER FOLDER IN THIS WINDOW'S PLACE, WITHOUT A RELOAD. The folder menu and an empty folder's offers point the window
// at another folder (the app's local.rs `point`), and the app hands this page the new folder's face. Reloading onto it
// blanked the whole window, rail and all, while the editor booted again. Instead the page moves itself: to the editor a
// local folder is one "sandbox" (`local-<id>`), so another folder is a sandbox switch, which the editor already makes in
// place (sandboxScope.ts resets everything scoped to the one being left, sandboxScreen.ts lands the new one on a screen).
// The rail stays where it is, and the folder's own page crossfades from the folder being left to the one arriving.

// How long the folder being left stays on screen while the one arriving draws its files, so the crossfade runs between
// two finished pages. A folder the sidecar is slow to walk shows its page still loading after this, rather than holding
// a frozen frame any longer.
export const ARRIVAL_WAIT_MS = 600;

// The one switch this window has under way, and the folder whose files it waits to see drawn.
let waiting: { readonly sandboxId: string; readonly done: () => void } | undefined;

/** LocalFiles.vue has drawn the files of the folder the editor knows as `sandboxId`: a switch waiting on it may show it. */
export const folderDrawn = (sandboxId: string): void => {
    if (waiting?.sandboxId !== sandboxId) {
        return;
    }
    const { done } = waiting;
    waiting = undefined;
    done();
};

// Settles once `sandboxId`'s files are drawn, or after `ms` whatever they are doing.
const drawnWithin = (sandboxId: string, ms: number): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (waiting?.done === done) {
                waiting = undefined;
            }
            resolve();
        }, ms);
        const done = (): void => {
            clearTimeout(timer);
            resolve();
        };
        waiting = { sandboxId, done };
    });

/**
 * Moves the editor onto `face`'s folder: the face worn, the folder's "sandbox" listed and selected (the desktop page's
 * platform answers with the face just worn), Files landed on, and its files drawn. Rejects when the editor did not end
 * up on the folder, which leaves the window to be reloaded onto it.
 */
export const moveTo = async (face: LocalFace): Promise<void> => {
    const sandboxId = localSandboxId(face);
    const sandbox = useSandbox();
    // Waited on from before the switch: a folder this window showed before may have its files cached, and draw at once.
    const drawn = drawnWithin(sandboxId, ARRIVAL_WAIT_MS);
    wearFace(face);
    setPageTitle(face.name);
    // Files, as the reload did, rather than whatever screen this folder was last left on: the reader asked for a folder.
    landOnAfterSwitch(sandboxId, `/workspace`);
    await sandbox.refresh();
    if (sandbox.activeSandboxId.value !== sandboxId) {
        throw new Error(`the editor stayed on ${sandbox.activeSandboxId.value ?? `no folder`} instead of ${sandboxId}`);
    }
    await drawn;
    await nextTick();
};

// What the app would have done had the page not taken the switch: its face is already kept for the reload (local.rs).
const reloadOnto = (): void => {
    window.history.replaceState(null, ``, `${window.location.pathname}#/workspace`);
    window.location.reload();
};

/**
 * The whole switch, as a view transition where the webview draws one: the page as it stands is held while the move
 * runs, then crossfades into what it became (motion.css). With motion off the crossfade takes no time, so the page cuts
 * from one finished folder to the other, never through one half drawn.
 */
export const switchTo = async (face: LocalFace): Promise<void> => {
    try {
        if (typeof document.startViewTransition !== `function`) {
            await moveTo(face);
            return;
        }
        await document.startViewTransition(() => moveTo(face)).updateCallbackDone;
    } catch (error) {
        console.error(`[local] the window could not move to ${face.path} in place; reloading onto it:`, error);
        reloadOnto();
    }
};

// Taken, so the app does not reload the window, only when the detail is a face this page can move to.
const take = (event: Event): void => {
    const face = event instanceof CustomEvent ? faceOf(event.detail) : undefined;
    if (face === undefined) {
        return;
    }
    event.preventDefault();
    void switchTo(face);
};

/** Takes the app's `intentic:repoint` while the local shell is up (LocalShell.vue); the returned function stops taking it. */
export const takeFolderSwitches = (): (() => void) => {
    window.addEventListener(LOCAL_REPOINT_EVENT, take);
    return () => window.removeEventListener(LOCAL_REPOINT_EVENT, take);
};
