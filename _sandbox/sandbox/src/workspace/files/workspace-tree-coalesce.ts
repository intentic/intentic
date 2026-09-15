import type { WorkspaceTree } from "@intentic/sandbox-contract";

// Shares one workspace walk between the callers asking for it at the same moment. The walk is ~350ms of syscalls and a
// few thousand microtasks on the daemon's single loop, and it is requested by every open editor tab, every agent scope
// and the classify route — measured, 68% of slow /workspace/tree requests arrived while the previous one was still in
// flight, and 53% within half a second of it. Those are the same tree; walking it twice answers nobody faster.
//
// Keyed by root because the route walks a per-agent worktree as readily as the shared tree, and two roots have nothing
// to share.

// How long a settled walk still answers a new caller. Matched to git.routes' scan window deliberately: both exist to
// absorb the burst of refetches one editor render fans out, and neither should outlive a person's sense of "now".
const REUSE_MS = 500;

type Pending = { readonly tree: Promise<WorkspaceTree>; reusableUntil: number };

export type WorkspaceTreeWalk = (root: string) => Promise<WorkspaceTree>;

export const coalescingWorkspaceTree = (walk: WorkspaceTreeWalk, reuseMs: number = REUSE_MS): WorkspaceTreeWalk => {
    const pending = new Map<string, Pending>();
    return (root: string): Promise<WorkspaceTree> => {
        const shared = pending.get(root);
        // `reusableUntil` at 0 marks a walk still running, which every caller may join however long it takes.
        if (shared !== undefined && (shared.reusableUntil === 0 || Date.now() < shared.reusableUntil)) {
            return shared.tree;
        }
        // Every expired tree, not just this root's: a worktree is asked for once and then archived, and a whole
        // workspace listing held per dead conversation is exactly the retention this route was making worse.
        const now = Date.now();
        for (const [key, entry] of pending) {
            if (entry.reusableUntil !== 0 && now >= entry.reusableUntil) {
                pending.delete(key);
            }
        }
        const entry: Pending = {
            reusableUntil: 0,
            tree: walk(root).then(
                (tree) => {
                    entry.reusableUntil = Date.now() + reuseMs;
                    return tree;
                },
                (error: unknown) => {
                    // A failed walk is dropped rather than cached, so the next caller retries instead of inheriting it.
                    pending.delete(root);
                    throw error;
                },
            ),
        };
        pending.set(root, entry);
        return entry.tree;
    };
};
