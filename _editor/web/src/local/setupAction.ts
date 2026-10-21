import { localHost, type LocalSetupAction } from "../app/environments/localHost";
import type { SetupCardAction } from "./setupCard";
import { useLocalProject } from "./useLocalProject";

// WHAT A PRESS ON A FOLDER'S WAY TO ITS SANDBOX DOES, wherever it is pressed: the app's own verbs through the host, the
// folder's sandbox, and This computer in this window. Held here rather than in the card because the folder's own
// button offers the same next step (setupCard.ts `folderButtonOf`), and two copies of this would be two answers to one
// press.
//
// The route is handed in, so this module stays below the router as the rest of `local/` does.

const APP_VERBS: ReadonlySet<SetupCardAction> = new Set<LocalSetupAction>([`startDocker`, `retry`, `consent`, `restart`, `signOut`, `log`, `dismiss`]);
const isAppVerb = (action: SetupCardAction): action is LocalSetupAction => APP_VERBS.has(action);

/**
 * Runs `action`, taking the reader to `go(path)` for the one that is a place rather than a verb.
 *
 * Handed back to the button, whose press lock holds it for as long as the press runs: a start of the engine takes
 * minutes, and a second press meanwhile would only start it again. What it came to is said on the card
 * (`actionFailure`).
 */
export const runSetupAction = (action: SetupCardAction, go: (path: string) => void): Promise<void> | undefined => {
    const project = localHost().project;
    const { open, signIn, pressed } = useLocalProject();
    if (action === `details`) {
        if (project !== undefined) {
            go(project.detailsPath);
        }
        return undefined;
    }
    if (action === `open`) {
        return open();
    }
    // Said on the card from the press on, so the reader is told to finish in the browser rather than asked again.
    if (action === `signIn` || action === `signInAgain`) {
        return signIn();
    }
    if (project !== undefined && isAppVerb(action)) {
        return pressed(() => project.act(action));
    }
    return undefined;
};
