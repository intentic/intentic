import { commandShortcut } from "../../../../shell/commands/useCommands";
import { t } from "@intentic/ui/i18n";
import { localFace } from "../../../../app/environments/local";
import { useNotifications } from "../../../../shell/notifications/notifications";
import { type DeleteBatch, takeDelete } from "./deleteUndo";
import { restoredReceipt } from "../entryNames";
import { useWorkspaceTree } from "../useWorkspaceTree";

// The command Mod+Z runs; the page that binds it registers it under this name.
export const UNDO_DELETE = `workspace.undoDelete`;

// Where a local window's delete went: the system's own trash, since the desktop app's sidecar trashes rather than unlinks
// and answers no id to take it back by. Windows calls it the Recycle Bin; the user agent is the page's one word of the OS.
const trashedTo = (): string => (/windows/i.test(navigator.userAgent) ? t(`local.trash.recycleBin`) : t(`local.trash.trash`));

// Taking a delete back, from a receipt's Undo or from Mod+Z: the same restore either way, so pressing both brings the
// files back once. Its own receipt carries no Undo: deleting them again is one keystroke away in the tree.
export const useDeleteUndo = () => {
    const store = useWorkspaceTree();
    const { say, warn, report } = useNotifications();

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
                warn(t(`workspace.fileVerbs.noLongerInTrash`, {}, gone));
                return;
            }
            say(said);
        }, t(`workspace.fileVerbs.couldntRestore`));
    };

    // A delete's receipt, whose Undo takes back exactly that batch and whose tooltip names the chord where one is bound.
    // A batch holding no id has nothing this tab could take back, so it offers no Undo: a folder on this computer sends a
    // delete to the system's own trash, and its receipt says so instead (app/environments/local.ts).
    const sayDeleted = (receipt: string, batch: DeleteBatch): void => {
        if (batch.entries.length === 0) {
            report({ tone: `done`, title: receipt, detail: localFace() === undefined ? undefined : trashedTo() });
            return;
        }
        say(receipt, () => undoDelete(batch), commandShortcut(UNDO_DELETE));
    };

    return { undoDelete, sayDeleted };
};
