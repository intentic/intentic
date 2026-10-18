import { cancellableGit, defaultGit } from "@intentic/base/git";
import type { Logger } from "pino";
import type { WorkspacePaths } from "../workspace/workspace.js";

// The git a workspace history runs, and what it is made with: split out of history.ts, whose length is held by its
// baseline.

// Runs git with the scope's detached-worktree env; injectable so command sequences are unit-testable without a real
// repo. A `signal` (the restore-point collection's budget alone) kills the git it runs.
export type HistoryGitRunner = (
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly signal?: AbortSignal },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

// Through the daemon's git helper rather than a fork of the daemon itself. `core.fileMode=true` overrides the helper's
// global false: a snapshot must keep an executable bit, or a restore strips it from every script added since.
export const defaultRunner: HistoryGitRunner = (args, options) =>
    (options.signal === undefined ? defaultGit : cancellableGit(options.signal))(options.cwd, ["-c", "core.fileMode=true", ...args], options.env);

export interface WorkspaceHistoryOptions {
    readonly workspace: WorkspacePaths;
    readonly historyRoot: string;
    readonly logger: Logger;
    // The restore-point collection's prune grace and clock (restore-point-retention.ts); only a test sets them.
    readonly retentionGraceMs?: number;
    readonly now?: () => number;
}
