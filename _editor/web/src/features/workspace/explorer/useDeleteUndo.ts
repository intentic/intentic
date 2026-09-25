import { commandShortcut } from "../../../shell/commands/useCommands";
import { useNotifications } from "../../../shell/notifications/notifications";
import { type DeleteBatch, takeDelete } from "./deleteUndo";
import { restoredReceipt } from "./entryNames";
import { useWorkspaceTree } from "./useWorkspaceTree";

// The command Mod+Z runs; the page that binds it registers it under this name.
export const UNDO_DELETE = `workspace.undoDelete`;

// Taking a delete back, from a receipt's Undo or from Mod+Z: the same restore either way, so pressing both brings the
// files back once. Its own receipt carries no Undo: deleting them again is one keystroke away in the tree.
export const useDeleteUndo = () => {
    const store = useWorkspaceTree();
    const { say, warn } = useNotifications();

    // The named batch, or the newest delete this tab still holds.
    const undoDelete = async (batch?: DeleteBatch): Promise<void> => {
        const taken = takeDelete(batch);
        if (taken === undefined) {
            return;
        }
        await store.run(async () => {
            const { landed, gone } = await store.restoreDeleted(taken);
            const said = restoredReceipt(
                taken.entries.map((entry) => entry.path),
                landed,
                gone,
            );
            if (said === undefined) {
                warn(gone === 1 ? `That is no longer in the trash` : `Those are no longer in the trash`);
                return;
            }
            say(said);
        }, `Couldn't restore that.`);
    };

    // A delete's receipt, whose Undo takes back exactly that batch and whose tooltip names the chord where one is bound.
    const sayDeleted = (receipt: string, batch: DeleteBatch): void => {
        say(receipt, () => undoDelete(batch), commandShortcut(UNDO_DELETE));
    };

    return { undoDelete, sayDeleted };
};
