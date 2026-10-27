import { t } from "@intentic/ui/i18n";
import { holdsLockedWorkspacePath } from "@intentic/sandbox-contract/state/locked-folders";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract/state/workspace-state";
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { noticeOf } from "@intentic/ui/async";
import { basename } from "@intentic/ui/path";
import type { Ref } from "vue";
import { archiveAbove, isArchiveContent } from "../../../../models/workspace/files/archiveEntries";
import { isLeaving, type Provisional, provisionalAt } from "../../../../models/workspace/files/provisionalEntries";
import type { useWorkspaceTree } from "../../../../models/workspace/tree/useWorkspaceTree";
import { deadLink, dropDirOf, type Row } from "./treeRows";

// What any file surface may do to an entry: nothing to a private (children inherit it) or provisional path, no archive
// write, and no delete, move or rename of a folder the private entries sit in.

export interface TreeRulesHost {
    readonly byPath: Readonly<Ref<ReadonlyMap<string, WorkspaceTreeEntry>>>;
    readonly store: Pick<ReturnType<typeof useWorkspaceTree>, "actionError" | "canWriteAt">;
}

export const useTreeRules = (host: TreeRulesHost) => {
    const entryAt = (path: string): WorkspaceTreeEntry | undefined => host.byPath.value.get(path);

    // What this browser has just done here that the listing hasn't caught up with, which nothing may act on. Only for a
    // path the listing DOESN'T have, or a folder on the way to an upload would read as arriving itself.
    const pendingRow = (path: string): Provisional | undefined => (host.byPath.value.has(path) ? undefined : provisionalAt(path));
    const pending = (path: string): boolean => pendingRow(path) !== undefined;
    // Selection filtered to paths the ops may actually touch, so bulk delete doesn't hit paths the daemon will refuse, nor
    // placeholder rows for files that aren't on disk under that name yet.
    const unlockedOnly = (paths: readonly string[]): string[] =>
        paths.filter((path) => !isLockedWorkspacePath(path) && !pending(path) && !isLeaving(path));

    // Inside an archive nothing can be written: what a row there names is a copy the daemon keeps out of sight, and
    // nothing repacks a zip. The archive FILE itself is ordinary workspace content.
    const archiveDir = (dir: string): boolean => archiveAbove(dir, entryAt) !== undefined;
    const archived = (path: string): boolean => isArchiveContent(path, entryAt);
    // Whether the member may change this path by hand (their edit fence; useWorkspaceTree's `canWriteAt`).
    const writable = (path: string): boolean => host.store.canWriteAt(path);
    // A folder that takes no drop: the sandbox keeps it private, it is an archive's contents, or the member may not
    // change it, so neither drag lights it as a place to land.
    const noDrops = (dir: string): boolean => isLockedWorkspacePath(dir) || archiveDir(dir) || !writable(dir);
    // What a row offers a move: its folder, unless the sandbox keeps that folder private or the link leads nowhere.
    const dropTargetOf = (row: Row): string | undefined => (noDrops(dropDirOf(row)) || deadLink(row.entry) ? undefined : dropDirOf(row));
    // Whether a verb aimed at `dir` is refused: an archive's contents say why in words, since the menu offers Extract
    // there; outside the member's edit fence the verb was never offered (the menus withdraw it), so a key that still
    // reaches it does nothing rather than explaining a press nobody was shown.
    const refuseIn = (dir: string): boolean => {
        if (archiveDir(dir)) {
            host.store.actionError.value = noticeOf(t(`workspace.fileVerbs.archiveReadOnly`));
            return true;
        }
        return !writable(dir);
    };

    // `.intentic` and its groups are opened and written inside like any folder, but stay where they are: deleting one
    // would take the sandbox's settings, sign-ins and history with it (holdsLockedWorkspacePath). A verb that would carry one
    // is refused whole, saying why, rather than done to the rest of the selection, so nothing happens that wasn't asked.
    const refuseKept = (paths: readonly string[]): boolean => {
        const kept = paths.find(holdsLockedWorkspacePath);
        if (kept !== undefined) {
            host.store.actionError.value = noticeOf(t(`workspace.fileVerbs.keptInPlace`, { name: basename(kept) }));
        }
        return kept !== undefined;
    };

    return { pendingRow, pending, unlockedOnly, archiveDir, archived, noDrops, dropTargetOf, refuseIn, refuseKept, writable };
};
