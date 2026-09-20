import {
    type Fence,
    fenceAllows,
    fenceIntersection,
    fenceReaches,
    isAttachmentPath,
    type WorkspaceChildren,
    type WorkspaceClassification,
    type WorkspaceTree,
    type WorkspaceTreeEntry,
} from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";

// What a fenced person is shown of the workspace. Point reads refuse (slices/slice-scope.ts); listings PRUNE, because
// a folder that 403s on every click is a worse answer than a folder that isn't there — the fence is meant to be the
// shape of the workspace as far as this person is concerned, not a wall they keep walking into.

/**
 * Whether the fence lets a read or a write of this path through at all.
 * An attachment is exempt by design: it belongs to a message, not to the workspace, and a fenced member who cannot
 * write one cannot put a file in front of the agent they are allowed to talk to.
 */
export const fenceOpens = (fence: Fence, relPath: string): boolean => fenceAllows(fence, relPath) || isAttachmentPath(relPath);

// The refusal a fenced caller meets on a path outside their slices. Names the folders they DO hold rather than the
// one they asked for: the path is already theirs to know, and the folders are what turns a dead end into a next step.
export const refuseFenced = (fence: Fence, relPath: string): void => {
    if (fenceOpens(fence, relPath)) {
        return;
    }
    const folders = fence ?? [];
    throw new ORPCError("FORBIDDEN", {
        message:
            folders.length === 0
                ? "your access to this workspace holds no folders; ask the owner for a slice"
                : `outside your access to this workspace, which holds ${folders.join(", ")}`,
    });
};

/**
 * The same refusal for LISTING a folder, which admits one more case: a folder on the way down to an allowed one.
 * Refusing `finance` to someone fenced to `finance/reports` would leave the report they hold unreachable.
 */
export const refuseUnlistable = (fence: Fence, relPath: string): void => {
    if (fenceReaches(fence, relPath) || isAttachmentPath(relPath)) {
        return;
    }
    refuseFenced(fence, relPath);
};

// Keeps the entries the fence admits, plus the ancestors leading to them; an admitted folder keeps its subtree whole,
// an ancestor keeps only the branches that lead somewhere.
const prune = (fence: Fence, entries: readonly WorkspaceTreeEntry[]): WorkspaceTreeEntry[] =>
    entries.flatMap((entry) => {
        if (fenceAllows(fence, entry.path)) {
            return [entry];
        }
        if (!fenceReaches(fence, entry.path)) {
            return [];
        }
        // On the way down: keep the folder, and inside it only what still leads somewhere. `children` absent means the
        // walk never opened it, which stays absent rather than becoming an empty folder.
        return [entry.children === undefined ? entry : { ...entry, children: prune(fence, entry.children) }];
    });

/**
 * The tree as this caller may see it. `hidden` is left alone: it counts what the walk's budget cut, and folding a
 * fence into that number would tell a fenced reader there is more of the workspace than they can see, which is the
 * one thing the count must not do.
 */
export const fencedTree = (fence: Fence, tree: WorkspaceTree): WorkspaceTree =>
    fence === undefined ? tree : { ...tree, tree: prune(fence, tree.tree), barren: tree.barren.filter((path) => fenceReaches(fence, path)) };

/** One folder's listing, cut the same way. Asked only after the folder itself proved reachable. */
export const fencedChildren = (fence: Fence, children: WorkspaceChildren): WorkspaceChildren =>
    fence === undefined ? children : { ...children, entries: prune(fence, children.entries) };

/** The classification proposal, cut to the entries this caller can act on; it is a list of top-level paths. */
export const fencedClassification = (fence: Fence, classified: WorkspaceClassification): WorkspaceClassification =>
    fence === undefined ? classified : { classifications: classified.classifications.filter((entry) => fenceAllows(fence, entry.path)) };

/**
 * The subtrees a search may actually run over: what the caller asked for, met with what they hold.
 * Undefined is the whole index. An EMPTY list is the engine's own "nothing matches" (scan.ts filterScope keeps an
 * entry only when some prefix contains it), which is the answer a fence admitting no folder has to produce — the
 * index covers the whole tree, so leaving the scope open here would hand out snippets from folders that refuse.
 */
export const searchPaths = (fence: Fence, dir: string): readonly string[] | undefined => fenceIntersection(fence, dir === "" ? undefined : [dir]);

/** Repository ids a caller may be told about: the ones inside their fence, and the ones on the way down to it. */
export const fencedRepos = (fence: Fence, repos: readonly string[]): string[] =>
    fence === undefined ? [...repos] : repos.filter((repo) => fenceReaches(fence, repo));

/** A `filter` predicate for any list whose rows name a workspace path, so a row-shaped answer cuts like a tree does. */
export const fencedTo =
    <T>(fence: Fence, pathOf: (row: T) => string) =>
    (row: T): boolean =>
        fenceAllows(fence, pathOf(row));
