import { localHost, type LocalSetupAction } from "../app/environments/localHost";
import type { SetupPress } from "./setup/setupView";
import { useLocalProject } from "./useLocalProject";

// WHAT A PRESS ON A FOLDER'S WAY TO ITS SANDBOX DOES, wherever it is pressed: the page's own ask, the app's own verbs
// through the host, the folder's sandbox, and This computer in this window. Held here rather than in the page so the
// page and anything else that offers the same next step give one answer to one press.
//
// The route is handed in, so this module stays below the router as the rest of `local/` does.

const APP_VERBS: ReadonlySet<SetupPress> = new Set<LocalSetupAction>([`startDocker`, `retry`, `consent`, `restart`, `signOut`, `log`, `dismiss`]);
const isAppVerb = (action: SetupPress): action is LocalSetupAction => APP_VERBS.has(action);

/**
 * Runs `action`, taking the reader to `go(path)` for the one that is a place rather than a verb.
 *
 * Handed back to the button, whose press lock holds it for as long as the press runs: a start of the engine takes
 * minutes, and a second press meanwhile would only start it again. What it came to is said on the page
 * (`actionFailure`).
 */
export const runSetupAction = (action: SetupPress, go: (path: string) => void): Promise<void> | undefined => {
    const project = localHost().project;
    const { create, open, signIn, pressed } = useLocalProject();
    switch (action) {
        case `create`:
        case `signInCreate`:
            return create();
        case `details`:
            if (project !== undefined) {
                go(project.detailsPath);
            }
            return undefined;
        case `open`:
            return open();
        // Said on the page from the press on, so the reader is told to finish in the browser rather than asked again.
        case `signIn`:
        case `signInAgain`:
            return signIn();
        default:
            return project !== undefined && isAppVerb(action) ? pressed(() => project.act(action)) : undefined;
    }
};
