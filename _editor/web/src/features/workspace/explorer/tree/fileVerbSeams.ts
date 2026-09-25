import { useNotifications } from "../../../../shell/notifications/notifications";
import { useTerminalPanel } from "../../../terminal/useTerminalPanel";
import { useUploadQueue } from "../../files/upload/useUploadQueue";
import { useDeleteUndo } from "../undo/useDeleteUndo";
import { useWorkspaceTree } from "../useWorkspaceTree";
import type { FileVerbSeams } from "./fileVerbs";

// The app's own answers to what a file surface's verbs reach: kept apart from fileVerbs.ts so a suite that passes fakes
// never loads the terminal panel or the daemon's store.
export const fileVerbSeams = (): FileVerbSeams & { readonly store: ReturnType<typeof useWorkspaceTree> } => {
    const terminalPanel = useTerminalPanel();
    return {
        store: useWorkspaceTree(),
        uploads: useUploadQueue(),
        say: useNotifications().say,
        sayDeleted: useDeleteUndo().sayDeleted,
        openTerminal: (dir) => terminalPanel.spawnShell(dir),
    };
};
