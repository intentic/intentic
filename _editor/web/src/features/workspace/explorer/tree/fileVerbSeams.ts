import { localFace } from "../../../../app/environments/local";
import { useNotifications } from "../../../../workbench/notifications/notifications";
import { useTerminalPanel } from "../../../terminal/useTerminalPanel";
import { downloadEntries } from "../../files/downloadEntries";
import { useUploadQueue } from "../../files/upload/useUploadQueue";
import { useDeleteUndo } from "../undo/useDeleteUndo";
import { useWorkspaceTree } from "../useWorkspaceTree";
import type { FileVerbSeams } from "./fileVerbs";

// The daemon's store as a surface holds it: all of it, less unpacking where nothing unpacks.
type SurfaceStore = Omit<ReturnType<typeof useWorkspaceTree>, "extractEntry"> & Partial<Pick<ReturnType<typeof useWorkspaceTree>, "extractEntry">>;

// The app's own answers to what a file surface's verbs reach: kept apart from fileVerbs.ts so a suite that passes fakes
// never loads the terminal panel or the daemon's store. A folder on this computer (app/environments/local.ts) is handed
// only what its sidecar can answer: no archive route to unpack with, no shell, and no download onto the computer the
// files are already on, so none of those verbs is offered there.
export const fileVerbSeams = (): FileVerbSeams & { readonly store: SurfaceStore } => {
    const store = useWorkspaceTree();
    const shared = { uploads: useUploadQueue(), say: useNotifications().say, sayDeleted: useDeleteUndo().sayDeleted };
    if (localFace() !== undefined) {
        return { ...shared, store: { ...store, extractEntry: undefined } };
    }
    const terminalPanel = useTerminalPanel();
    return {
        ...shared,
        store,
        openTerminal: (dir) => terminalPanel.spawnShell(dir),
        download: downloadEntries,
    };
};
