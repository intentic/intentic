import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { parentDir } from "@intentic/ui/path";
import { computed, type Ref } from "vue";
import { opensAsFolder } from "../../files/archiveEntries";
import { withProvisionalEntries } from "../../files/provisionalEntries";
import { type ExplorerFilters, technicalHidden } from "../explorerFilter";
import type { useEmptyDirs } from "../useEmptyDirs";
import type { useWorkspaceTree } from "../useWorkspaceTree";
import { deadLink, flattenRows, indexEntries, type Row } from "./treeRows";

// The tree the explorer draws, as reactive state: the by-path index over the eager walk and every lazy subtree, the
// visible rows in order (flattened by treeRows.ts), and which folders are open. Writes to the open set go through here.

export interface TreeRowsHost {
    readonly tree: () => readonly WorkspaceTreeEntry[];
    // The folder `tree` is the contents of, "" for the workspace root: it draws no row, so it is never opened.
    readonly rootDir: () => string;
    readonly rootHidden: () => number;
    readonly filter: () => string;
    // The toolbar's three switches (useLayout's), read by every level's filter and by the chip counting what one hid.
    readonly switches: { readonly [K in keyof ExplorerFilters]: Readonly<Ref<boolean>> };
    readonly nesting: Readonly<Ref<boolean>>;
    readonly store: Pick<ReturnType<typeof useWorkspaceTree>, "expanded" | "lazyChildren" | "lazyHidden">;
    readonly emptyDirs: Pick<ReturnType<typeof useEmptyDirs>, "isBarren" | "chainOf">;
}

export const useTreeRows = (host: TreeRowsHost) => {
    const { expanded, lazyChildren, lazyHidden } = host.store;
    // Children come from the eager walk's inline `children`, else the lazily-fetched map keyed by path.
    const childrenOf = (entry: WorkspaceTreeEntry): readonly WorkspaceTreeEntry[] => entry.children ?? lazyChildren.value.get(entry.path) ?? [];
    const byPath = computed(() => indexEntries(host.tree(), childrenOf));
    const filters = computed<ExplorerFilters>(() => ({
        showIgnored: host.switches.showIgnored.value,
        hideTests: host.switches.hideTests.value,
        hideTechnical: host.switches.hideTechnical.value,
    }));

    // Provisional entries join or leave each listing here, so a file gesture shows at the gesture, not a round trip later.
    const visibleRows = computed(() =>
        flattenRows({
            tree: host.tree(),
            rootDir: host.rootDir(),
            rootHidden: host.rootHidden(),
            filter: host.filter(),
            expanded: expanded.value,
            nesting: host.nesting.value,
            filters: filters.value,
            childrenOf,
            hiddenIn: (dir) => lazyHidden.value.get(dir) ?? 0,
            isBarren: host.emptyDirs.isBarren,
            chainOf: host.emptyDirs.chainOf,
            entryAt: (path) => byPath.value.get(path),
            listing: withProvisionalEntries,
        }),
    );
    // Visible order is the axis for Shift-range and arrow steps; markers are excluded so they can't be selected.
    const orderedPaths = computed<string[]>(() => visibleRows.value.filter((row): row is Row => !(`more` in row)).map((row) => row.entry.path));
    // Tooling entries the technical switch took out of the root, said on a chip so a bare tree never reads as the workspace.
    const technicalCount = computed(() => technicalHidden(host.tree(), filters.value));

    // The directory an op targets: a dir itself, else the file's parent, else the tree's own root.
    const targetDir = (path: string | null): string => {
        if (path === null) {
            return host.rootDir();
        }
        return byPath.value.get(path)?.type === `dir` ? path : parentDir(path);
    };

    // Whether a row has anything to expand into; a barren chain expands from its tail. No chevron when the tail has no
    // children, or the dir is locked, or the link is dead.
    const expandable = (row: Row): boolean =>
        (row.entry.type === `dir` || row.nest === true || opensAsFolder(row.entry)) &&
        !isLockedWorkspacePath(row.entry.path) &&
        !deadLink(row.entry) &&
        (row.barren !== true || childrenOf(row.chainTail ?? row.entry).length > 0);

    // Toggling expansion lazily fetches an unlisted dir, so a reload-restored folder loads like a fresh click.
    const toggleExpand = (path: string): void => {
        const next = new Set(expanded.value);
        if (next.has(path)) {
            next.delete(path);
        } else {
            next.add(path);
        }
        expanded.value = next;
    };
    // Opens the folder something is landing in, so what lands is not hidden in a closed one.
    const openFolder = (dir: string): void => {
        if (dir !== host.rootDir() && !expanded.value.has(dir)) {
            toggleExpand(dir);
        }
    };
    // Opens every folder on a way down at once, and writes nothing when they already are.
    const openAll = (dirs: readonly string[]): void => {
        if (dirs.some((dir) => !expanded.value.has(dir))) {
            expanded.value = new Set([...expanded.value, ...dirs]);
        }
    };

    return { byPath, childrenOf, visibleRows, orderedPaths, technicalCount, targetDir, expandable, toggleExpand, openFolder, openAll };
};
