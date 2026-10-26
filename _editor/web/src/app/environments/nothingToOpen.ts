import type { RouteLocationRaw } from "vue-router";
import { z } from "zod";

/* WHERE A READER WITH NOTHING TO OPEN LANDS: HOME, IN A BROWSER AND IN THE DESKTOP APP ALIKE (2026-10-26). The shell's
gate answers `/setup` for an account with no sandbox, and `/setup?sandbox=<id>` for one with a setup of its own left
unfinished (router/setupGate.ts). Both land on Home's first run (features/home/HomeNoSandbox.vue), which says what a
sandbox is, makes one on a press, and offers the unfinished one by name, finished in place in a tile of Home's rail
(features/home/newSandbox/). Nobody is moved out of Home for either: the setup page that used to answer them made a
sandbox by arriving, and in the desktop app handed its install over with This computer swapped in over the workspace; it
is gone, and its old addresses land on Home too (router/setupRoutes.ts). _(2026-10-22) The app put the reader on This
computer instead, with the workspace waiting behind it on a page saying there was nothing to open._ */

/**
 * The place for an account with nothing to open: Home's first run. The same address as lib/routes/firstScreens.ts
 * `HOME_PATH`, written out since `app` sits below `lib` and may not import it back.
 */
export const NOTHING_TO_OPEN_PATH = `/home`;

export interface NothingToOpen {
    /** The shell gate's answer as it stands here: any setup it names is Home's first run. */
    readonly settle: <Gate extends boolean | RouteLocationRaw>(gate: Gate) => Gate | typeof NOTHING_TO_OPEN_PATH;
}

/** The gate's answer that names a setup of the reader's own (setupGate.ts `setupRedirect`): `/setup` with the row named. */
const ResumedSetup = z.object({ path: z.literal(`/setup`) });

export const createNothingToOpen = (): NothingToOpen => ({
    settle: (gate) => (gate === `/setup` || ResumedSetup.safeParse(gate).success ? NOTHING_TO_OPEN_PATH : gate),
});

export const nothingToOpen: NothingToOpen = createNothingToOpen();
