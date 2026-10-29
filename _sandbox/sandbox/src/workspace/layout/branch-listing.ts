import { compareListed } from "@intentic/sandbox-contract/schemas/workspace/name-order";
import type { WorkspaceChildren, WorkspaceTree, WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { type BranchRegion, branchRegion, branchScopeOf, branchViewRoot, type ReadScope } from "./branch-view.js";
import { childrenForRead, type WorkspaceScopeDeps, workspaceRootFor } from "./workspace-scope.js";

// The tree and the folder listings of a scope. A conversation's checkout and the shared tree are each one folder walked
// as it stands; a branch view is two (branch-view.ts): the branch's checkout where its repository is, the shared tree
// everywhere else, so the walk of each is laid over the other along the region the branch answers for. A folder both
// hold (one leading to the viewed repository, or to a repository nested inside it) is listed from both, each entry
// taken from the side that answers for its path.

type Walk = (root: string) => Promise<WorkspaceTree>;
type List = (root: string, relPath: string, options?: { depth?: number }) => Promise<WorkspaceChildren>;

const listedOrder = (left: WorkspaceTreeEntry, right: WorkspaceTreeEntry): number =>
    compareListed({ name: left.name, dir: left.type === "dir" }, { name: right.name, dir: right.type === "dir" });

interface Sides {
    readonly shared?: WorkspaceTreeEntry;
    readonly own?: WorkspaceTreeEntry;
}

// The entry a path is listed as: its own side's, or for a mixed folder the side that answers for it, else the other.
const sideOf = (region: BranchRegion, path: string, sides: Sides): WorkspaceTreeEntry | undefined => {
    const owned = region.owns(path) ? sides.own : sides.shared;
    return region.mixed(path) ? (owned ?? sides.own ?? sides.shared) : owned;
};

// Whether a mixed folder has anything below it to lay together; one neither walk descended into stays unopened.
const descended = (sides: Sides): boolean => sides.shared?.children !== undefined || sides.own?.children !== undefined;

// One level of the two walks laid together: a mixed folder descends into both, every other entry is its side's whole.
const layLevel = (region: BranchRegion, shared: readonly WorkspaceTreeEntry[] | undefined, own: readonly WorkspaceTreeEntry[] | undefined): WorkspaceTreeEntry[] => {
    const byName = new Map<string, Sides>();
    for (const entry of shared ?? []) {
        byName.set(entry.name, { shared: entry });
    }
    for (const entry of own ?? []) {
        byName.set(entry.name, { ...byName.get(entry.name), own: entry });
    }
    const laid: WorkspaceTreeEntry[] = [];
    for (const sides of byName.values()) {
        const path = (sides.own ?? sides.shared)?.path ?? "";
        const kept = sideOf(region, path, sides);
        if (kept === undefined) {
            continue;
        }
        const mixed = region.mixed(path) && kept.type === "dir" && descended(sides);
        laid.push(mixed ? { ...kept, children: layLevel(region, sides.shared?.children, sides.own?.children) } : kept);
    }
    return laid.sort(listedOrder);
};

/**
 * The tree a scope reads. For a branch: the shared tree with the viewed repository's part of it replaced by the
 * branch's. No `generation`, since no change feed follows a branch view, and `root` is the shared tree's: every path in
 * it is a workspace path, resolved through the scope like any read.
 */
export const scopedTree = async (deps: WorkspaceScopeDeps, walk: Walk, scope: ReadScope): Promise<WorkspaceTree> => {
    const branch = branchScopeOf(scope);
    if (branch === undefined) {
        return walk(await workspaceRootFor(deps, scope));
    }
    const view = await branchViewRoot(deps.branches, branch);
    const region = await branchRegion(deps.main, branch.repo);
    const [shared, own] = await Promise.all([walk(deps.main), walk(view)]);
    const barren = [...shared.barren.filter((path) => !region.owns(path)), ...own.barren.filter((path) => region.owns(path))];
    return {
        root: deps.main,
        tree: region.dir === "" && region.deeper.length === 0 ? [...own.tree] : layLevel(region, shared.tree, own.tree),
        hidden: region.dir === "" ? own.hidden : shared.hidden,
        barren: barren.toSorted((left, right) => left.localeCompare(right)),
    };
};

// A flat listing's entries in the order a walk would meet them: parents first, each folder's entries as it lists them.
const pathOrder = (left: WorkspaceTreeEntry, right: WorkspaceTreeEntry): number => {
    const leftParts = left.path.split("/");
    const rightParts = right.path.split("/");
    for (let at = 0; at < Math.min(leftParts.length, rightParts.length); at += 1) {
        if (leftParts[at] !== rightParts[at]) {
            const leftDir = at < leftParts.length - 1 || left.type === "dir";
            const rightDir = at < rightParts.length - 1 || right.type === "dir";
            return compareListed({ name: leftParts[at] ?? "", dir: leftDir }, { name: rightParts[at] ?? "", dir: rightDir });
        }
    }
    return leftParts.length - rightParts.length;
};

/** A folder's listing in a scope, an archive's included. For a branch, from the side that answers for the folder. */
export const scopedChildren = async (deps: WorkspaceScopeDeps, list: List, scope: ReadScope, relPath: string, options?: { depth?: number }): Promise<WorkspaceChildren> => {
    const branch = branchScopeOf(scope);
    const root = await workspaceRootFor(deps, scope);
    const region = branch === undefined ? undefined : await branchRegion(deps.main, branch.repo);
    // One side alone: no branch, or a folder that is wholly the branch's or wholly the shared tree's.
    const alone = region === undefined || region.mixed(relPath) ? undefined : region.owns(relPath) ? root : deps.main;
    const archived = await childrenForRead(alone ?? root, relPath, options);
    if (archived !== undefined) {
        return archived;
    }
    if (region === undefined || alone !== undefined) {
        return list(alone ?? root, relPath, options);
    }
    const [shared, own] = await Promise.all([list(deps.main, relPath, options), list(root, relPath, options)]);
    const kept = new Map<string, WorkspaceTreeEntry>();
    for (const entry of shared.entries) {
        if (!region.owns(entry.path) || region.mixed(entry.path)) {
            kept.set(entry.path, entry);
        }
    }
    for (const entry of own.entries) {
        if (region.owns(entry.path)) {
            kept.set(entry.path, entry);
        }
    }
    return { entries: [...kept.values()].sort(pathOrder), hidden: shared.hidden + own.hidden };
};
