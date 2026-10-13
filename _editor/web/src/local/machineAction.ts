import { localHost, type LocalMachineAction } from "../app/environments/localHost";
import type { MachineCardAction } from "./machineCard";
import { useLocalProject } from "./useLocalProject";

// WHAT A PRESS ON THIS COMPUTER'S SANDBOX DOES, wherever it is pressed: the app's own verbs through the host, the
// folder's sandbox, the folder put in line again, and This computer in this window. Held here rather than in the card
// because the folder's own button offers the same next step (machineCard.ts `folderButtonOf`), and two copies of this
// would be two answers to one press.
//
// The route is handed in, so this module stays below the router as the rest of `local/` does.

const APP_VERBS: ReadonlySet<MachineCardAction> = new Set<LocalMachineAction>([`signIn`, `startDocker`, `retry`, `log`, `start`, `recreate`]);
const isAppVerb = (action: MachineCardAction): action is LocalMachineAction => APP_VERBS.has(action);

/**
 * Runs `action`, taking the reader to `go(path)` for the one that is a place rather than a verb.
 *
 * Handed back to the button, whose press lock holds it for as long as the press runs: a start of the engine takes
 * minutes, and a second press meanwhile would only start it again. What it came to is said on the card
 * (`actionFailure`).
 */
export const runMachineAction = (action: MachineCardAction, go: (path: string) => void): Promise<void> | undefined => {
    const project = localHost().project;
    const { retryFolder, open, pressed } = useLocalProject();
    if (action === `details`) {
        if (project !== undefined) {
            go(project.detailsPath);
        }
        return undefined;
    }
    if (action === `open`) {
        return open();
    }
    if (action === `retryFolder`) {
        return retryFolder();
    }
    if (project !== undefined && isAppVerb(action)) {
        return pressed(() => project.act(action));
    }
    return undefined;
};
