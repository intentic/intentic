import { stat } from "node:fs/promises";

/* WHICH FILES A SHELL COMMAND JUST CHANGED, for the hooks that only ever heard the edit tools.
 *
 * Post-edit diagnostics (agent-diagnostics.ts), the fault check on a freshly written test (agent-test-strength.ts)
 * and the edit ledger all listen on `Edit|Write`. A model that edits with `sed -i`, a heredoc or a script gets
 * none of them: no type errors back, no "this test passes against the old code", and a Stop that believes nothing
 * was touched. The harness's own bypass-mode instructions tell the model to PREFER those tools, so this is the
 * common case rather than a corner, and it is how a test file that did not compile reached main with every loop
 * in this directory reporting green.
 *
 * A shell command cannot say what it wrote, so the tree is asked instead. The dirty paths of the turn's repos
 * (git/changes.ts dirtyPathsAcross) and each one's mtime are snapshotted BEFORE the command and compared AFTER:
 * a path that is newly dirty, or dirty with a moved mtime, was written by that command and by nothing else. Two
 * snapshots rather than one rolling comparison, because a rolling one would charge the shell with edits the edit
 * tools made between two commands, and the diagnostics for those already went out.
 *
 * git status is the expensive half, ~50-100ms across the workspace's repos, twice per command. It runs only while
 * a hook that wants the answer is wired, so a workspace with none pays nothing.
 *
 * Two names per file, because the daemon and the agent disagree about them under isolation: `onDisk` is where
 * THIS process can stat the file (the worktree), `path` is how the agent names it and how the checker is asked
 * about it (agents/isolation.ts fromWorktree). Outside isolation the two are the same string. */
export interface ShellEdit {
    readonly path: string;
    readonly onDisk: string;
}

// The turn's dirty files, both names each. Injected: only the planner knows the worktree layout.
export type DirtyFiles = () => Promise<readonly ShellEdit[]>;

export interface ShellEditTracker {
    // Taken as the command starts (PreToolUse). A stat pass over the dirty set, so a turn with a hundred dirty
    // files pays a hundred stats, which is still nothing beside the command about to run.
    readonly before: () => Promise<void>;
    // What changed between the last `before` and now (PostToolUse). Without a `before` nothing can be attributed
    // and nothing is: a wrong attribution would send the model to fix a file this command never touched.
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
