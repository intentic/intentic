import { join } from "node:path";
import { SHARED_STATE_PATHS } from "@intentic/sandbox-contract";

// How a workspace path maps into an isolated turn's worktree and back (conversations/worktrees/isolation.ts builds the
// worktree and its namespace). Here, beside entering that namespace (namespace-entry.ts), so the code a turn runs (a
// script, a runtime) maps a path without importing conversations/.

// The part of an isolation plan the mapping reads: the real root, the worktree standing in for it, and the dirs mirrored
// from the main checkout rather than cut per worktree.
export interface WorktreeMapping {
    readonly root: string;
    readonly worktree: string;
    readonly mirrors: readonly string[];
}

// State subtrees kept shared, not per-worktree; root-relative, no trailing slash. Sorted shallowest-first so a parent
// mounted after a child could never shadow it.
export const SHARED_STATE = SHARED_STATE_PATHS.map((path) => path.replace(/\/$/, "")).toSorted(
    (a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1),
);

const sharedPrefixes = (plan: WorktreeMapping): string[] => [...SHARED_STATE, ...plan.mirrors];

// Which file a workspace path names for an isolated turn: the daemon uses it for a reported path, worktree-redirect.ts
// when there's no namespace. Only the root prefix moves; the rest is already correct.
export const inWorktree = (path: string, plan: WorktreeMapping | undefined): string => {
    if (plan === undefined || (path !== plan.root && !path.startsWith(`${plan.root}/`))) {
        return path;
    }
    const rel = path === plan.root ? "" : path.slice(plan.root.length + 1);
    if (sharedPrefixes(plan).some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) {
        return path;
    }
    // The root itself maps to the worktree root: `ls /work` must list the agent's own tree.
    return rel === "" ? plan.worktree : join(plan.worktree, rel);
};

// The same mapping backwards: what the agent calls a file the daemon named, so a daemon-side answer quoted back never
// hands over the real worktree path, which reads as an instruction to leave the namespace.
export const fromWorktree = (path: string, plan: WorktreeMapping | undefined): string => {
    if (plan === undefined || (path !== plan.worktree && !path.startsWith(`${plan.worktree}/`))) {
        return path;
    }
    return path === plan.worktree ? plan.root : join(plan.root, path.slice(plan.worktree.length + 1));
};
