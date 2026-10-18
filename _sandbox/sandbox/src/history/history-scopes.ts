import { join } from "node:path";
import { oneLine } from "@intentic/base/one-line";
import type { SnapshotTrigger } from "@intentic/sandbox-contract/schemas/history";
import type { BareRun } from "./restore-point-retention.js";
import type { WorkspacePaths } from "../workspace/workspace.js";

// The scopes workspace history snapshots (history.ts): what one is, where its bare git dir lives, how a command that
// needs no worktree reaches it, and how a snapshot commit of it reads back.

const MAX_LABEL_LENGTH = 160;

export interface Scope {
    // "root" or a repo id (root-relative dir, e.g. "clients/foo"); the wire-visible scope name.
    readonly name: string;
    readonly gitDir: string;
    readonly worktree: string;
}

export interface ScopeCommit {
    readonly sha: string;
    // Committer time, ms.
    readonly at: number;
    readonly id: string;
    readonly trigger: SnapshotTrigger;
    readonly label?: string;
}

// Labels live in commit bodies from free-form prompts; collapsed to one bounded line for git log parsing and the
// timeline row.
export const sanitizeLabel = (label: string): string | undefined => {
    const clean = oneLine(label, MAX_LABEL_LENGTH, { ellipsis: false });
    return clean === "" ? undefined : clean;
};

// Git dir name is the URI-encoded scope name; a nested repo id's slashes become %2F so each scope stays one filesystem
// entry.
export const scopeNamer =
    (scopesRoot: string, workspace: WorkspacePaths) =>
    (name: string): Scope => ({
        name,
        gitDir: join(scopesRoot, `${encodeURIComponent(name)}.git`),
        worktree: name === "root" ? workspace.root : join(workspace.root, name),
    });

// Tree-to-tree ops (log/diff-tree/cat-file) need no worktree, they must work after a repo is deleted.
export const bareIn =
    (historyRoot: string) =>
    (scope: Scope): BareRun => ({ cwd: historyRoot, env: { GIT_DIR: scope.gitDir } });
