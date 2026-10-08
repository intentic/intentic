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

// Stable path to the real workspace root inside the namespace, for a turn that genuinely needs the shared tree.
// Unmounted again for a fenced turn: it is the whole workspace, which is what that turn's checkout was cut down from.
export const MAIN_MOUNT = "/mnt/intentic-main";

// pnpm's package store, which pnpm keeps at the top of the mount a project sits on: `/work/.pnpm-store` for every
// project in the tree. Inside a namespace that path is the worktree's own, so each conversation's first install would
// download everything again into a store of its own. Bound back from the main tree: the store is content-addressed and
// pnpm shares one between concurrent installs by design, and the path an overlaid `node_modules` names in its
// `.modules.yaml` stays the one pnpm finds. The tree is private; the cache is not. Conditional like the shelf: a
// workspace nobody ran pnpm in has none, and the worktree keeps its own then.
export const PACKAGE_STORE = ".pnpm-store";

// Per-conversation runtime state the session store symlinks onto the workspace (sessions/session-store.ts); settings and
// skills stay container-local on purpose. Here, not in the store, because a fenced conversation's own store
// (turn-sandbox.ts) and the agent's HOME (agent-home.ts) need the same names before a turn starts: the symlinks are made
// once, at boot, against the shared path, and a namespace binds a different directory under them.
export const SESSION_STATE = ["projects", "plans", "backups", "tasks", "sessions", "session-env", "shell-snapshots", "todos"];

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
