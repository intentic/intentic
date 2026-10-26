import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { sandboxScopeGuard, sandboxValue } from "@intentic/extension-api";
import { parentDir } from "@intentic/ui/path";
import { nextTick, type Ref, watch } from "vue";
import { revealTargets } from "../revealPath";
import type { MoreRow, Row } from "./treeRows";

// Opens the tree down to the file the editor has open and scrolls its row into view, once per path once its row exists
// (retried as the rows change). Keyed by path, not every refetch, so a folder the reader collapsed stays collapsed; focus
// is never stolen.

// Like the open-folder set, this outlives the tree component: returning to Files must not reopen folders the reader
// collapsed around an unchanged selection. A different sandbox starts with no file revealed.
const revealedPath = sandboxValue<string | undefined>(() => undefined);

export interface TreeRevealHost {
    readonly selectedPath: () => string | null | undefined;
    readonly rows: Readonly<Ref<readonly (Row | MoreRow)[]>>;
    readonly tree: () => readonly WorkspaceTreeEntry[];
    readonly byPath: Readonly<Ref<ReadonlyMap<string, WorkspaceTreeEntry>>>;
    readonly childrenOf: (entry: WorkspaceTreeEntry) => readonly WorkspaceTreeEntry[];
    readonly nesting: Readonly<Ref<boolean>>;
    readonly openAll: (dirs: readonly string[]) => void;
    readonly showRow: (path: string) => Promise<HTMLElement | undefined>;
}

export const useTreeReveal = (host: TreeRevealHost): void => {
    watch(
        [host.selectedPath, host.rows],
        async () => {
            const path = host.selectedPath();
            if (path === undefined || path === null || path === revealedPath.value) {
                return;
            }
            // The path's own directory decides whether nesting folds it; an unloaded parent folds nothing.
            const parent = parentDir(path);
            const parentEntry = host.byPath.value.get(parent);
            const siblings = parent === `` ? host.tree() : parentEntry === undefined ? [] : host.childrenOf(parentEntry);
            host.openAll(revealTargets(path, siblings, host.nesting.value));
            // Claimed before the await: expanding re-runs this watch, so two passes could both scroll the same row.
            revealedPath.value = path;
            const here = sandboxScopeGuard();
            await nextTick();
            if ((await host.showRow(path)) === undefined && here() && revealedPath.value === path) {
                revealedPath.value = undefined; // not a row yet (or filtered out): a later pass reveals it
            }
        },
        { immediate: true },
    );
};
