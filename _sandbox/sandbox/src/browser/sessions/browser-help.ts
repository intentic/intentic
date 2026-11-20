import { windowChanged } from "../state/window-feed.js";
import { browserWindows as sessions } from "../state/window-registry.js";

// State side of the help-request flow (accounts-tools.ts holds the waiter); the view's banner renders from this.
// Looked up by account, since a profile can only be open in one running session; undefined if that account isn't
// browsing.
export const raiseBrowserHelp = (
    account: string,
    help: { readonly requestId: string; readonly message: string; readonly requestedAt: number },
    abandon: (note: string) => void,
): string | undefined => {
    const record = [...sessions.values()].find((candidate) => candidate.server === account && candidate.finishedAt === undefined);
    if (record === undefined) {
        return undefined;
    }
    record.help = help;
    record.abandonHelp = abandon;
    windowChanged(record, true);
    return record.name;
};

// Clears by requestId, not session name, so this can't clear a newer request raised on the same session.
export const clearBrowserHelp = (requestId: string): void => {
    for (const record of sessions.values()) {
        if (record.help?.requestId === requestId) {
            record.help = undefined;
            record.abandonHelp = undefined;
            windowChanged(record);
        }
    }
};
