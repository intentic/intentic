import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { isLockedWorkspacePath, type Persona } from "@intentic/sandbox-contract";
import { noticeOf } from "@intentic/ui/async";
import { computed, type Ref } from "vue";
import { lensPersonaId, reachOf } from "../../directory-ui/personaReach";
import { archiveAbove, isArchiveContent } from "../../files/archiveEntries";
import { isLeaving, type Provisional, provisionalAt } from "../../files/provisionalEntries";
import type { useWorkspaceTree } from "../useWorkspaceTree";
import { deadLink, dropDirOf, type Row } from "./treeRows";

// What may be done to a row. A sandbox-private path (isLockedWorkspacePath, so children inherit it) takes no rename,
// delete, cut, copy, drag or drop; an archive's contents take no write; a provisional row takes nothing; a lens only
// dims.

export interface TreeRulesHost {
    readonly byPath: Readonly<Ref<ReadonlyMap<string, WorkspaceTreeEntry>>>;
    readonly expandable: (row: Row) => boolean;
    readonly store: Pick<ReturnType<typeof useWorkspaceTree>, "actionError" | "refuseWrite">;
    // The sandbox's personas, one of which the explorer may be reading the tree as (lensPersonaId).
    readonly personas: Readonly<Ref<readonly Persona[]>>;
}

export const useTreeRules = (host: TreeRulesHost) => {
    const entryAt = (path: string): WorkspaceTreeEntry | undefined => host.byPath.value.get(path);

    const lensReach = computed(() => {
        const persona = host.personas.value.find((candidate) => candidate.id === lensPersonaId.value);
        return persona === undefined ? undefined : reachOf(persona);
    });
    // Whether the read-as persona's lens would refuse this path; only dims the row, since a lens must not restrict the
    // actual user. A folder on the way to a reachable child is never dimmed.
    const refused = (path: string): boolean => lensReach.value?.refuses(path) === true;

    // What this browser has just done here that the listing hasn't caught up with, which nothing may act on. Only for a
    // path the listing DOESN'T have, or a folder on the way to an upload would read as arriving itself.
    const pendingRow = (path: string): Provisional | undefined => (host.byPath.value.has(path) ? undefined : provisionalAt(path));
    const pending = (path: string): boolean => pendingRow(path) !== undefined;
    // An arriving row holding nothing a press can reach: activation refuses a pending file, while a pending directory
    // still expands. Said on the row as aria-, since the row still selects, reveals and takes a context menu.
    const notYetOpenable = (row: Row): boolean => pending(row.entry.path) && !host.expandable(row);
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
            host.store.actionError.value = noticeOf(`An archive's contents are read-only. Extract it to change them.`);
            return true;
        }
        return host.store.refuseWrite();
    };

    return { refused, pendingRow, pending, notYetOpenable, unlockedOnly, archiveDir, archived, noDrops, dropTargetOf, refuseIn };
};
