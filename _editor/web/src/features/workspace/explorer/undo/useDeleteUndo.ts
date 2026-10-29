import { workspaceView } from "../../../../app/workspaceScope";
import { commandShortcut } from "../../../../workbench/commands/useCommands";
import { t } from "@intentic/ui/i18n";
import { localFace } from "../../../../app/environments/local";
import { useNotifications } from "../../../../workbench/notifications/notifications";
import { basename, parentDir } from "@intentic/ui/path";
import { type DeleteBatch, type FileStep, type MoveBatch, takeStep } from "../../../../models/workspace/tree/deleteUndo";
import { restoredReceipt } from "../entryNames";
import { useWorkspaceTree } from "../../../../models/workspace/tree/useWorkspaceTree";

// The command Mod+Z runs; the page that binds it registers it under this name.
export const UNDO_DELETE = `workspace.undoDelete`;

// Where a local window's delete went: the system's own trash, since the desktop app's sidecar trashes rather than unlinks
// and answers no id to take it back by. Windows calls it the Recycle Bin; the user agent is the page's one word of the OS.
const trashedTo = (): string => (/windows/i.test(navigator.userAgent) ? t(`local.trash.recycleBin`) : t(`local.trash.trash`));

// Taking a file change back, from a delete receipt's Undo or from Mod+Z: the same step either way, so pressing both takes
// it back once. Its own receipt carries no Undo: doing it again is one gesture away in the tree.
export const useDeleteUndo = () => {
    const store = useWorkspaceTree();
    const { say, warn, report } = useNotifications();

    // Each entry moved home, newest first, so a folder moved and then renamed unwinds in the order it was done. A rename
    // in place says the name it went back to; a move says how many came back.
    const unmove = async ({ moves }: MoveBatch): Promise<void> => {
        const view = workspaceView.value;
        await store.run(async () => {
            for (const { from, to } of moves.toReversed()) {
                await store.moveEntry(to, from, false, view);
            }
            const [only] = moves;
            say(
                moves.length === 1 && only !== undefined && parentDir(only.from) === parentDir(only.to)
                    ? t(`workspace.fileVerbs.renamedBack`, { name: basename(only.from) })
                    : t(`workspace.fileVerbs.movedBack`, { count: moves.length }, moves.length),
            );
        }, t(`workspace.fileVerbs.couldntUndo`));
    };
    // What was made goes to the trash, as a delete would send it, but this is the undo: it is not remembered again.
    const unmake = async (created: readonly string[]): Promise<void> => {
        await store.run(async () => {
            const batch = await store.removeEntries(created);
            takeStep(batch);
            say(t(`workspace.fileVerbs.madeUndone`, { count: created.length }, created.length));
        }, t(`workspace.fileVerbs.couldntUndo`));
    };

    // The named step, or the newest this tab still holds.
    const undoStep = async (step?: FileStep): Promise<void> => {
        const taken = takeStep(step);
        if (taken === undefined) {
            return;
        }
        if (`moves` in taken) {
            await unmove(taken);
            return;
        }
        if (`created` in taken) {
            await unmake(taken.created);
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
        say(receipt, () => undoStep(batch), commandShortcut(UNDO_DELETE));
    };

    return { undoStep, sayDeleted };
};
