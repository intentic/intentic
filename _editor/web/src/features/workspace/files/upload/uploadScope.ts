import { copyNatively } from "./nativeCopy";
import { isShared, workspaceView } from "../../../../app/workspaceScope";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";

// Bulk import helpers only understand the shared tree; scoped uploads use the single-file route.
export const sharedUploadRoute = (route: Parameters<typeof supportsRoute>[0]): boolean => isShared(workspaceView.value) && supportsRoute(route);
export const requireUploadScope = (): void => {
    if (!isShared(workspaceView.value) && !supportsRoute(`git.viewChanges`)) {
        throw new Error(`This sandbox needs an update before uploading to a selected checkout.`);
    }
};

export const copyInSharedWorkspace = (...args: Parameters<typeof copyNatively>): ReturnType<typeof copyNatively> =>
    isShared(workspaceView.value) ? copyNatively(...args) : Promise.resolve(`declined`);
