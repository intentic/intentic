import { isLockedWorkspacePath, type WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { parentDir } from "@intentic/ui/path";
import { computed } from "vue";
import { useLayout } from "../../../workbench/window/useLayout";
import { explorerShows } from "../explorer/explorerFilter";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";
import { workspaceDir } from "../../../app/workspaceScope";
import { coverIn, coverIndex, coversBelow, NO_COVERS } from "./homeCover";

// What the loaded tree knows of one cover name (homeCover.ts), for the two surfaces that draw it: the explorer marks
// the folders holding one, and the home reads the current folder's copy. Both ask the same questions of the same tree,
// so the mark on a row and the page beside it cannot disagree.

// A folder as a row draws it: whether it holds a cover of its own (undefined until its listing or the tree's index can
// say), and how many folders below it do, as far as the loaded tree knows.
export interface CoverMark {
    readonly holds: boolean | undefined;
    readonly inside: number;
}

export function useCover(name: () => string | undefined) {
    const { entriesByPath, listingOf, entry: entryAt } = useWorkspaceTree();
    const layout = useLayout();
    const shows = (entry: WorkspaceTreeEntry): boolean => explorerShows(entry, layout.explorerFilters.value);

    // What the sandbox keeps private is never listed or read: not a file to show, and asking only raises its refusal.
    const unlocked = (entry: WorkspaceTreeEntry): boolean => !isLockedWorkspacePath(entry.path);
    // Every folder from the scope's root down to `dir` is one the switches show: a cover behind a hidden folder is one no
    // row could lead to, so it is neither counted nor offered.
    const reachable = (dir: string): boolean => {
        for (let path = dir; path !== workspaceDir.value && path !== ``; path = parentDir(path)) {
            const folder = entryAt(path);
            if (folder !== undefined && !shows(folder)) {
                return false;
            }
        }
        return true;
    };
    // Nothing inside an ignored folder counts unless the reader shows those: node_modules alone is full of READMEs.
    const known = computed(() => {
        const wanted = name();
        if (wanted === undefined) {
            return NO_COVERS;
        }
        const showIgnored = layout.explorerFilters.value.showIgnored;
        const files = [...entriesByPath.value.values()].filter((file) => file.type === `file` && (showIgnored || file.ignored !== true));
        return coverIndex(files, wanted, reachable);
    });

    // The file in a listing that answers for the name.
    const coverOf = (listing: readonly WorkspaceTreeEntry[]): WorkspaceTreeEntry | undefined => {
        const wanted = name();
        return wanted === undefined ? undefined : coverIn(listing.filter(unlocked), wanted);
    };
    // A folder's own listing says, once there is one; the tree's index until then.
    const mark = (path: string): CoverMark => {
        const listing = listingOf(path);
        const holds = listing === undefined ? (known.value.held.has(path) ? true : undefined) : coverOf(listing) !== undefined;
        return { holds, inside: known.value.below.get(path) ?? 0 };
    };
    // The folders below `dir` holding one, nearest first.
    const below = (dir: string, limit: number): readonly string[] => coversBelow(known.value, dir, limit);

    return { coverOf, mark, below };
}
