import type {
    FileDiff,
    GitBranch,
    GitChange,
    GitCommit,
    GitPublishFileResult,
    GitRemoteBranch,
    GitRemoteState,
    ScratchPath,
    StashEntry,
} from "@intentic/sandbox-contract";
import type { GitCloneOptions, GitStatus, GitSyncResult } from "@intentic/scaffold";
import type {
    ActionResult,
    checkoutRef,
    cherryPick,
    commitChanges,
    commitLog,
    createBranchAt,
    createTagAt,
    deleteTag,
    dropCommit,
    mergeCommit,
    pushTag,
    rebaseOnto,
    resetTo,
    revertCommit,
} from "./changes/changes-commits.js";
import type { commitFileDiff, conflictedFileDiff, refFileDiff, stagedFileDiff, unstagedFileDiff } from "./changes/changes-diff.js";
import type { commitIndex, discardPaths, stageAll, stagePaths, unstagePaths } from "./changes/changes-index.js";
import type { changedFiles } from "./changes/changes.js";
import type { scratchOf, ScratchScope } from "./changes/scratch.js";
import type { createBranch, deleteBranch, listBranches, listRemoteBranches } from "./ops/branches.js";
import type { collectRepoDiff, CommitScope, RepoDiff } from "./ops/commit-message.js";
import type { abortOperation, GitOperation, operationInProgress } from "./ops/operation.js";
import type { publishFile } from "./ops/publish-file.js";
import type { stashApply, stashChanges, stashDrop, stashList, stashPush } from "./ops/stash.js";
import type { UndoableAction, undoableAction, undoLastAction } from "./ops/undo.js";
import type { remoteProjectOf } from "./remote/remote-urls.js";
import type { fetchRemote, pullRemote, remoteState } from "./remote/remote.js";

// Git as the daemon runs it on the workspace's repositories: status, history, changes, branches and remotes.
export interface GitSlice {
    readonly git: {
        readonly init: (dir: string, separateGitDir?: string) => Promise<void>;
        readonly status: (dir: string) => Promise<GitStatus>;
        readonly listFiles: (dir: string) => Promise<string[]>;
        readonly commitAll: (dir: string, message: string, author: { name: string; email: string }) => Promise<boolean>;
        readonly clone: (parentDir: string, name: string, cloneUrl: string, options?: GitCloneOptions) => Promise<void>;
        readonly checkout: (dir: string, ref: string) => Promise<void>;
        readonly head: (dir: string) => Promise<string>;
        // Unabbreviated HEAD sha, the form a sha-pinned capability config stores.
        readonly fullHead: (dir: string) => Promise<string>;
        readonly sync: (dir: string) => Promise<GitSyncResult>;
        // Changes review verbs: status split into index/worktree, index moves, whole-repo commits, discard, diffs.
        readonly changedFiles: (dir: string) => Promise<{
            branch?: string;
            head?: string;
            conflicted: GitChange[];
            staged: GitChange[];
            unstaged: GitChange[];
            // Object names status already reported per path; free here, a spawn per file elsewhere.
            blobs: Map<string, { head?: string; index?: string }>;
        }>;
        readonly stagePaths: (dir: string, paths: readonly string[]) => Promise<void>;
        // The whole repository in one spawn, nothing built or chunked; why staging everything has no size limit.
        readonly stageAll: (dir: string, scratch?: readonly ScratchPath[]) => Promise<void>;
        // What a stage-everything leaves out of the checkout at `dir` because it looks like scratch.
        readonly scratchOf: (dir: string, scope: ScratchScope) => Promise<ScratchPath[]>;
        readonly unstagePaths: (dir: string, paths: readonly string[]) => Promise<void>;
        readonly commitIndex: (dir: string, message: string, author: { name: string; email: string }) => Promise<boolean>;
        readonly discardPaths: (dir: string, paths?: readonly string[]) => Promise<void>;
        // Branches and the remote; remote verbs return an ActionResult since 'no remote' is an outcome, not an error.
        readonly listBranches: (dir: string) => Promise<GitBranch[]>;
        // Remote-tracking branches, so the switcher can pair main with origin/main instead of unrelated peers.
        readonly listRemoteBranches: (dir: string) => Promise<GitRemoteBranch[]>;
        readonly createBranch: (dir: string, name: string, start: string | undefined, checkout: boolean) => Promise<void>;
        readonly deleteBranch: (dir: string, name: string, force: boolean) => Promise<void>;
        // known.branch lets a caller that already holds the checked-out branch skip re-deriving it.
        readonly remoteState: (dir: string, known?: { readonly branch?: string | undefined }) => Promise<GitRemoteState>;
        readonly fetchRemote: (dir: string) => Promise<ActionResult>;
        readonly pullRemote: (dir: string, author: { name: string; email: string }) => Promise<ActionResult>;
        // Where the repo is online (host + owner/name), so it can be matched against a project id from elsewhere.
        readonly remoteProjectOf: (dir: string) => Promise<{ host: string; project: string } | undefined>;
        // One file onto the default branch and out to the remote in one step; write is passed in by the router.
        readonly publishFile: (
            dir: string,
            file: { path: string; content: string; message: string },
            write: (content: string) => Promise<void>,
        ) => Promise<GitPublishFileResult>;
        // The working tree's two diffs, one per Changes-panel side; fileDiff's ref is a conversation's base sha.
        readonly stagedFileDiff: (dir: string, path: string) => Promise<FileDiff>;
        readonly unstagedFileDiff: (dir: string, path: string) => Promise<FileDiff>;
        readonly conflictedFileDiff: (dir: string, path: string) => Promise<FileDiff>;
        readonly fileDiff: (dir: string, path: string, ref: string) => Promise<FileDiff>;
        readonly refFileDiff: (dir: string, path: string, base: string, tip: string) => Promise<FileDiff>;
        // Git-history graph, read-only: one repo's commit log across all refs, lazy per-commit detail on request.
        readonly commitLog: (dir: string, limit: number, skip?: number) => Promise<{ branch?: string; commits: GitCommit[]; hasMore: boolean }>;
        // What one repo contributes to an AI commit message: recent subjects, file list, and the diff to be recorded.
        readonly collectRepoDiff: (repo: string, dir: string, scope: CommitScope) => Promise<RepoDiff>;
        readonly commitChanges: (dir: string, sha: string) => Promise<GitChange[]>;
        readonly commitFileDiff: (dir: string, sha: string, path: string) => Promise<FileDiff>;
        // The halted-operation pair, for what a terminal left (a rebase stopped on conflict), not this daemon's verbs.
        readonly operationInProgress: (dir: string) => Promise<GitOperation | undefined>;
        readonly abortOperation: (dir: string, operation: GitOperation) => Promise<void>;
        // The stash, read here because nothing else used to; an entry is a commit, which is why it reads like one.
        readonly stashList: (dir: string) => Promise<StashEntry[]>;
        readonly stashChanges: (dir: string, ref: string) => Promise<GitChange[]>;
        readonly stashPush: (
            dir: string,
            options: { message?: string; includeUntracked?: boolean },
        ) => Promise<{ ok: true } | { ok: false; reason: string }>;
        readonly stashApply: (dir: string, ref: string, pop: boolean) => Promise<{ ok: true } | { ok: false; reason: string }>;
        readonly stashDrop: (dir: string, ref: string) => Promise<void>;
        // Walks the current branch back off its own reflog, the ref-level complement to a checkpoint restore.
        readonly undoableAction: (dir: string) => Promise<UndoableAction | undefined>;
        readonly undoLastAction: (
            dir: string,
            expectedPreviousSha: string,
            discardChanges: boolean,
        ) => Promise<{ ok: true; action: UndoableAction } | { ok: false; reason: string }>;
        // Graph write actions: non-destructive refs return void and propagate errors, sequence ops return a value.
        readonly createBranchAt: (dir: string, name: string, sha: string) => Promise<void>;
        readonly createTagAt: (dir: string, name: string, sha: string) => Promise<void>;
        // The other two things one does with a tag, so a tag pill is not create-only.
        readonly deleteTag: (dir: string, name: string, remote: string | undefined) => Promise<void>;
        readonly pushTag: (dir: string, name: string, remote: string) => Promise<ActionResult>;
        readonly checkoutRef: (dir: string, ref: string) => Promise<void>;
        readonly resetTo: (dir: string, sha: string, mode: "soft" | "mixed" | "hard") => Promise<void>;
        readonly revertCommit: (dir: string, sha: string, author: { name: string; email: string }) => Promise<ActionResult>;
        readonly cherryPick: (dir: string, sha: string, author: { name: string; email: string }) => Promise<ActionResult>;
        readonly mergeCommit: (dir: string, sha: string, author: { name: string; email: string }) => Promise<ActionResult>;
        readonly rebaseOnto: (dir: string, sha: string, author: { name: string; email: string }) => Promise<ActionResult>;
        readonly dropCommit: (dir: string, sha: string, author: { name: string; email: string }) => Promise<ActionResult>;
    };
}
