import type { RouteLocationRaw } from "vue-router";
import { desktopVersion, openThisComputer, takeHandedToFolder } from "./desktop";
import { sandboxFace } from "./local";

/* THE DESKTOP APP'S WORKSPACE WITH NOTHING TO OPEN (2026-10-22). An account with no sandbox used to land on setup the
moment the workspace's page arrived anywhere (a sign-in coming back, a launch onto the workspace), and setup is not a
screen to look at: arriving there makes the account a sandbox (features/setup/flow/useSetupArrival.ts). The app has a
place that needs no sandbox, This computer, and a reader who signed in may want nothing more than its files. So in the
app the reader is put on This computer, and the workspace's page waits behind it on a screen that says there is nothing
to open yet and offers both ways on (NoSandbox.vue): what the reader sees if they bring the workspace up from the tray.
Setup is still one press away there, and by its own address ("Add a sandbox", "Put agents to work"), which never passes
through here.

A browser has no This computer. Since Home became the first screen (2026-10-25) it has Home instead: its first run says
what a sandbox is and makes one on a press (features/home/HomeNoSandbox.vue, the Add sandbox dialog), where setup used to
start a machine the moment the page arrived. An unfinished setup of the reader's own is still resumed, on either. */

export const NO_SANDBOX_PATH = `/no-sandbox`;

/**
 * A browser's place for an account with nothing to open: Home's first run. The same address as lib/routes/firstScreens.ts
 * `HOME_PATH`, written out since `app` sits below `lib` and may not import it back.
 */
export const NOTHING_TO_OPEN_PATH = `/home`;

export interface StandAsideHost {
    /** Whether this page is the desktop app's workspace, the one window with a This computer to step aside for. */
    readonly inApp: () => boolean;
    /** Bring This computer to the front, in the workspace's place. */
    readonly showThisComputer: () => void;
    /** Whether the reader was just put on a folder of this computer (a sign-in begun there), once: nothing to bring up. */
    readonly takeHandedBack: () => boolean;
}

export interface StandAside {
    /**
     * The shell gate's answer as it stands here: a blank setup is This computer in the app, with the page waiting behind
     * it, and Home's first run in a browser.
     */
    readonly settle: <Gate extends boolean | RouteLocationRaw>(gate: Gate) => Gate | typeof NO_SANDBOX_PATH | typeof NOTHING_TO_OPEN_PATH;
}

export const createStandAside = (host: StandAsideHost): StandAside => ({
    settle: (gate) => {
        const alreadyThere = host.takeHandedBack();
        if (gate !== `/setup`) {
            return gate;
        }
        if (!host.inApp()) {
            return NOTHING_TO_OPEN_PATH;
        }
        if (!alreadyThere) {
            host.showThisComputer();
        }
        return NO_SANDBOX_PATH;
    },
});

export const workspaceAside: StandAside = createStandAside({
    // The app's offline sandbox face runs these routes too, on this computer's own sandboxes: not the workspace.
    inApp: () => desktopVersion() !== undefined && !sandboxFace(),
    showThisComputer: openThisComputer,
    takeHandedBack: takeHandedToFolder,
});

/** Where a page that has just found nothing to open sends its reader: Home's first run, or This computer in the app (above). */
export const setupOrThisComputer = (): RouteLocationRaw => workspaceAside.settle(`/setup`);
