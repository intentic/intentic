import { stat } from "node:fs/promises";
import { dirtyPathsAcross } from "../../git/changes/changes.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";

// Detects a shell edit (sed -i, a heredoc, a mv) for hooks that only hear Edit|Write: a dirty file whose inode changed
// since the command started was changed by it. ctime, not mtime, since a rename keeps a file's mtime. `onDisk` is where
// this process stats the file; `path` is the agent's name, which isolation makes different.
export interface ShellEdit {
    readonly path: string;
    readonly onDisk: string;
}

// The turn's dirty files, both names each; injected since only the planner knows the worktree layout.
export type DirtyFiles = () => Promise<readonly ShellEdit[]>;

export interface ShellEditTracker {
    // Marks the command's start and nothing more, so the command never waits on a scan.
    readonly before: () => void;
    // What changed since the last `before`; without one, nothing is attributed to avoid a wrong blame.
    readonly changed: () => Promise<readonly ShellEdit[]>;
}

export const createShellEditTracker = (dirty: DirtyFiles, now: () => number = Date.now): ShellEditTracker => {
    let startedAt: number | undefined;
    return {
        before: () => {
            startedAt = now();
        },
        changed: async () => {
            const since = startedAt;
            startedAt = undefined;
            if (since === undefined) {
                return [];
            }
            const files = await dirty().catch((): readonly ShellEdit[] => []);
            const touched = await Promise.all(
                files.map(async (edit) => {
                    try {
                        return (await stat(edit.onDisk)).ctimeMs >= since ? edit : undefined;
                    } catch {
                        // Deleted or unreadable: there is no file left to check, so there is nothing to attribute.
                        return undefined;
                    }
                }),
            );
            return touched.filter((edit) => edit !== undefined);
        },
    };
};

// Milliseconds a turn reuses its checkout's repo list: discovery walks up to 10k dirs, and every shell command asks.
const REPOS_REUSED_MS = 60_000;

// The paths a turn's checkout has dirty, root-relative across its root repo and every nested one, with the repo list
// walked at most once per REPOS_REUSED_MS. What both readers around a command ask of the tree: the edit diagnostics
// above and the documents a command wrote (produced-documents.ts).
export const checkoutDirtyPaths = (root: string, now: () => number = Date.now): (() => Promise<string[]>) => {
    let repos: { readonly at: number; readonly list: Promise<string[]> } | undefined;
    return async () => {
        const at = now();
        if (repos === undefined || at - repos.at > REPOS_REUSED_MS) {
            repos = { at, list: discoverRepos(root) };
        }
        return dirtyPathsAcross(root, await repos.list);
    };
};
