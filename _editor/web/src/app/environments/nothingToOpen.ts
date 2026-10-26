import type { RouteLocationRaw } from "vue-router";
import { z } from "zod";
import { desktopWorkspace } from "./desktopWorkspace";

/* WHERE A READER WITH NOTHING TO OPEN LANDS: HOME, IN A BROWSER AND IN THE DESKTOP APP ALIKE (2026-10-26). The shell's
gate answers `/setup` for an account with no sandbox, and a setup page is not a screen to look at: arriving there makes the
account a sandbox (features/setup/flow/useSetupArrival.ts). Since Home became the first screen (2026-10-25) it has Home's
first run instead, which says what a sandbox is and makes one on a press (features/home/HomeNoSandbox.vue).

The desktop app's workspace lands there too, and so does its reader with a setup of their own left unfinished, which the
gate answers with `/setup?sandbox=<id>` and a browser still resumes there. In the app that page handed the install to the
app, which swapped This computer in over the workspace: a reader who had just signed in on Home was taken off it to a
card about preparing their PC that they had not asked to see. Home's first run offers that setup by name, and finishing it
runs in place, in a tile of Home's rail (features/home/newSandbox/), as a new sandbox does. _(2026-10-22) The app put the
reader on This computer instead, with the workspace waiting behind it on a page saying there was nothing to open; that
predates Home's first run, and took a reader who signed in on Home to another part of the app._ */

/**
 * The place for an account with nothing to open: Home's first run. The same address as lib/routes/firstScreens.ts
 * `HOME_PATH`, written out since `app` sits below `lib` and may not import it back.
 */
export const NOTHING_TO_OPEN_PATH = `/home`;

export interface NothingToOpenHost {
    /** Whether this page is the desktop app's workspace, which runs a setup on Home rather than on /setup. */
    readonly inApp: () => boolean;
}

export interface NothingToOpen {
    /** The shell gate's answer as it stands here: a blank setup is Home's first run, and so is a resumed one in the app. */
    readonly settle: <Gate extends boolean | RouteLocationRaw>(gate: Gate) => Gate | typeof NOTHING_TO_OPEN_PATH;
}

/** The gate's answer that resumes a setup of the reader's own (setupGate.ts `setupRedirect`): `/setup` with the row named. */
const ResumedSetup = z.object({ path: z.literal(`/setup`) });

export const createNothingToOpen = (host: NothingToOpenHost): NothingToOpen => ({
    settle: (gate) => (gate === `/setup` || (host.inApp() && ResumedSetup.safeParse(gate).success) ? NOTHING_TO_OPEN_PATH : gate),
});

export const nothingToOpen: NothingToOpen = createNothingToOpen({ inApp: desktopWorkspace });
