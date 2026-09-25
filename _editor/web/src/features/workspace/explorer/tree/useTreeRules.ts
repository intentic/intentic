import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { noticeOf } from "@intentic/ui/async";
import type { Ref } from "vue";
import { archiveAbove, isArchiveContent } from "../../files/archiveEntries";
import { isLeaving, type Provisional, provisionalAt } from "../../files/provisionalEntries";
import type { useWorkspaceTree } from "../useWorkspaceTree";
import { deadLink, dropDirOf, type Row } from "./treeRows";

// What any file surface may do to an entry: nothing to a private (children inherit it) or provisional path, no archive write.

export interface TreeRulesHost {
    readonly byPath: Readonly<Ref<ReadonlyMap<string, WorkspaceTreeEntry>>>;
    readonly store: Pick<ReturnType<typeof useWorkspaceTree>, "actionError" | "refuseWrite">;
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
    // A folder that takes no drop: the sandbox keeps it private, or it is an archive's contents.
    const noDrops = (dir: string): boolean => isLockedWorkspacePath(dir) || archiveDir(dir);
    // What a row offers a move: its folder, unless the sandbox keeps that folder private or the link leads nowhere.
    const dropTargetOf = (row: Row): string | undefined => (noDrops(dropDirOf(row)) || deadLink(row.entry) ? undefined : dropDirOf(row));
    // `refuseWrite` for the member tier, plus the archive rule, for a verb aimed at `dir`.
    const refuseIn = (dir: string): boolean => {
        if (archiveDir(dir)) {
            host.store.actionError.value = noticeOf(t(`workspace.fileVerbs.archiveReadOnly`));
            return true;
        }
        return host.store.refuseWrite();
    };

    return { pendingRow, pending, unlockedOnly, archiveDir, archived, noDrops, dropTargetOf, refuseIn };
};
