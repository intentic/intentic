import { stat } from "node:fs/promises";

// Detects a shell edit (sed -i, a heredoc) for hooks that only hear Edit|Write. Snapshots each dirty file's mtime
// before and after a command: a changed or newly-dirty path was written by it and nothing else. `onDisk` is where this
// process stats the file; `path` is the agent's name, which isolation makes different.
export interface ShellEdit {
    readonly path: string;
    readonly onDisk: string;
}

// The turn's dirty files, both names each; injected since only the planner knows the worktree layout.
export type DirtyFiles = () => Promise<readonly ShellEdit[]>;

export interface ShellEditTracker {
    // Taken as the command starts; a stat per dirty file, negligible beside the command about to run.
    readonly before: () => Promise<void>;
    // What changed since the last `before`; without one, nothing is attributed to avoid a wrong blame.
    readonly changed: () => Promise<readonly ShellEdit[]>;
}

type Snapshot = ReadonlyMap<string, { readonly edit: ShellEdit; readonly mtime: number }>;

const snapshotOf = async (dirty: DirtyFiles): Promise<Snapshot> => {
    const files = await dirty().catch((): readonly ShellEdit[] => []);
    const seen = new Map<string, { edit: ShellEdit; mtime: number }>();
    await Promise.all(
        files.map(async (edit) => {
            try {
                seen.set(edit.path, { edit, mtime: (await stat(edit.onDisk)).mtimeMs });
            } catch {
                // Deleted or unreadable: there is no file left to check, so there is nothing to attribute.
            }
        }),
    );
    return seen;
};

export const createShellEditTracker = (dirty: DirtyFiles): ShellEditTracker => {
    let baseline: Snapshot | undefined;
    return {
        before: async () => {
            baseline = await snapshotOf(dirty);
        },
        changed: async () => {
            if (baseline === undefined) {
                return [];
            }
            const now = await snapshotOf(dirty);
            const was = baseline;
            baseline = undefined;
            return [...now.values()].filter(({ edit, mtime }) => was.get(edit.path)?.mtime !== mtime).map(({ edit }) => edit);
        },
    };
};
