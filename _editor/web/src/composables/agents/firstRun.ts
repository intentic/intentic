/* WHETHER THIS WORKSPACE HAS EVER HAD AN AGENT STARTED IN IT — the one fact the desktop's first landing turns
 * on. A sandbox nobody has delegated anything in yet opens on the fleet board rather than the file tree:
 * handing a task to an agent that works on its own branch is what the product is for, and an empty explorer
 * teaches none of it at the one moment the user is most willing to learn. Once they have started their first
 * agent the desktop goes back to opening on the workspace, so this changes the FIRST session and no other.
 *
 * Per sandbox, because a second workspace is a second first run — the same axis the commit draft and the
 * prepush clock are keyed by. localStorage rather than the daemon: this is a fact about what this reader has
 * already been shown, and the daemon deliberately keeps nothing about a reader at rest.
 *
 * Storage can be unavailable (private mode), and both directions fail SAFE toward the board: an unreadable
 * flag reads as a first run, which shows the board once more than needed and breaks nothing, where the other
 * default would hide it from exactly the person it exists for. */

const storageKey = (id: string): string => `intentic.agentStarted.${id}`;

export const agentStarted = (id: string | undefined): boolean => {
    // No active sandbox yet is the first run by construction — there is no workspace to have opened before.
    if (id === undefined) {
        return false;
    }
    try {
        return localStorage.getItem(storageKey(id)) === `1`;
    } catch {
        return false;
    }
};

// Called from the one funnel every "New agent" surface goes through (agentActions.startAgent), and again by the
// board whenever it finds agents already on it — a workspace driven from another browser, or from before this
// flag existed, is not a first run however this browser's storage looks.
export const markAgentStarted = (id: string | undefined): void => {
    if (id === undefined) {
        return;
    }
    try {
        localStorage.setItem(storageKey(id), `1`);
    } catch {
        // Nothing to do: the landing simply stays on the board for this browser.
    }
};
