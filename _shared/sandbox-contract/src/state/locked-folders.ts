import { STATE_DIR } from "@intentic/constants";
import { LOCKED_STATE_ENTRIES } from "./workspace-state.js";

// Whether a path is a folder a locked entry sits in (workspace-state.ts): the root's `.intentic` and each of its groups.
// Such a folder is opened, read and written inside like any other, but never deleted, moved, renamed or copied onto,
// for anyone. Deleting or moving it would carry the locked bytes out from under the lock, and the sandbox's settings,
// sign-ins and history with them, and the file trash sits in `.intentic/local`, so it would leave no Undo either. A
// copy onto it merges, overwriting the locked files. The file API refuses all of these and the explorer leaves them
// out. Accepts either slash.
export const holdsLockedWorkspacePath = (relPath: string): boolean => {
    const segments = relPath.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
    if (segments[0] !== STATE_DIR) {
        return false;
    }
    const inside = segments.slice(1).join("/");
    return inside === "" || [...LOCKED_STATE_ENTRIES].some((entry) => entry.startsWith(`${inside}/`));
};
