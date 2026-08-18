import { oc } from "@orpc/contract";
import {
    CommitResultSchema,
    CommitSchema,
    DiscardSchema,
    FileDiffSchema,
    GitActionResultSchema,
    GitBranchCreateAtSchema,
    GitBranchCreateSchema,
    GitBranchDeleteSchema,
    GitBranchesSchema,
    GitChangesSchema,
    GitCheckoutSchema,
    GitCommitActionSchema,
    GitCommitDiffQuerySchema,
    GitCommitDiffSchema,
    GitCommitFileDiffQuerySchema,
    GitFileDiffQuerySchema,
    GitFileQuerySchema,
    GitFileSchema,
    GitFilesSchema,
    GitFileWriteSchema,
    GitLogQuerySchema,
    GitLogSchema,
    GitOperationStateSchema,
    GitPublishFileResultSchema,
    GitPublishFileSchema,
    GitUndoSchema,
    GitUndoStateSchema,
    GitRemoteReposSchema,
    GitRemoteStateSchema,
    GitReposSchema,
    GitResetSchema,
    GitStageSchema,
    GitStatusSchema,
    GitTagCreateSchema,
    GitTagDeleteSchema,
    GitTagPushSchema,
    OkSchema,
    PushSchema,
    RepoParamSchema,
    StashApplySchema,
    StashDiffQuerySchema,
    StashListSchema,
    StashPushSchema,
    StashRefParamSchema,
} from "../schemas.js";

// Per-repo git ops over the workspace repos: "root" (the /work repo) plus every discovered repo under /work
// ({repo} is the repo's root-relative dir, URL-encoded). An unknown {repo} is a handler-thrown
// NOT_FOUND; a path that escapes the repo is a BAD_REQUEST. `changes` is the workspace-wide review set the
// Changes panel renders; commit/discard take optional `paths` for per-file actions.
export const gitContract = {
    changes: oc.route({ method: "GET", path: "/git/changes" }).output(GitChangesSchema),
    // The git-history graph over one repo's real commits: the repo list (for the tree affordance + switcher),
    // one repo's commit log, and lazy per-commit detail (changed files, then a file's before/after AT the
    // commit). Read-only — commit/discard on the working tree stay the write path (above).
    repos: oc.route({ method: "GET", path: "/git/repos" }).output(GitReposSchema),
    // The same repos with the host + project their remote names — how a caller recognises a workspace repo in a
    // list of `owner/name` strings that came from somewhere else. Kept off `repos` (a `git remote -v` per repo).
    remoteRepos: oc.route({ method: "GET", path: "/git/remote-repos" }).output(GitRemoteReposSchema),
    log: oc.route({ method: "GET", path: "/git/{repo}/log" }).input(GitLogQuerySchema).output(GitLogSchema),
    commitDiff: oc.route({ method: "GET", path: "/git/{repo}/commit-diff" }).input(GitCommitDiffQuerySchema).output(GitCommitDiffSchema),
    commitFileDiff: oc.route({ method: "GET", path: "/git/{repo}/commit-file-diff" }).input(GitCommitFileDiffQuerySchema).output(FileDiffSchema),
    // Write actions from the graph's commit context menu (VSCode "Git Graph" parity). Non-destructive refs
    // (branch/tag) return Ok and let git's errors propagate; the sequence + HEAD-moving ops return a
    // GitActionResult so a conflict/clean-apply failure is a value, not a 500. Read routes above.
    /* The halted-operation pair. `operation` is a READ every git surface can use to explain a worktree it cannot
     * otherwise act on; `abort` is the single way out, and it is git's own `--abort` rather than anything
     * clever. Neither is reachable from the daemon's own verbs — those abort themselves — so this exists purely
     * for what a terminal left behind. */
    operation: oc.route({ method: "GET", path: "/git/{repo}/operation" }).input(RepoParamSchema).output(GitOperationStateSchema),
    abort: oc.route({ method: "POST", path: "/git/{repo}/abort" }).input(RepoParamSchema).output(GitActionResultSchema),
    /* Walk the current branch back to where it was before its last action, off the branch's own reflog. The
     * complement to the Checkpoints timeline, not a duplicate of it: a checkpoint restores the working tree,
     * this moves the ref. The read carries `previousSha`, which the write sends back as a concurrency token —
     * an undo prepared against a stale view is refused rather than landing somewhere unlooked-at. */
    undoable: oc.route({ method: "GET", path: "/git/{repo}/undo" }).input(RepoParamSchema).output(GitUndoStateSchema),
    undo: oc.route({ method: "POST", path: "/git/{repo}/undo" }).input(GitUndoSchema).output(GitActionResultSchema),
    /* The stash. Read as a list plus a per-entry diff, mirroring the commit log and commit-diff pair above,
     * because a stash entry is a commit and the graph renders it as one. The writes are git's own four verbs;
     * only `drop` is unrecoverable, and the route checkpoints before it. */
    stashes: oc.route({ method: "GET", path: "/git/{repo}/stashes" }).input(RepoParamSchema).output(StashListSchema),
    stashDiff: oc.route({ method: "GET", path: "/git/{repo}/stash-diff" }).input(StashDiffQuerySchema).output(GitCommitDiffSchema),
    stashPush: oc.route({ method: "POST", path: "/git/{repo}/stash" }).input(StashPushSchema).output(GitActionResultSchema),
    stashApply: oc.route({ method: "POST", path: "/git/{repo}/stash/apply" }).input(StashApplySchema).output(GitActionResultSchema),
    stashDrop: oc.route({ method: "POST", path: "/git/{repo}/stash/drop" }).input(StashRefParamSchema).output(OkSchema),
    createBranch: oc.route({ method: "POST", path: "/git/{repo}/branch" }).input(GitBranchCreateSchema).output(OkSchema),
    createTag: oc.route({ method: "POST", path: "/git/{repo}/tag" }).input(GitTagCreateSchema).output(OkSchema),
    // The other two things one does with a tag, so the graph's tag pills are not a create-only affordance.
    deleteTag: oc.route({ method: "POST", path: "/git/{repo}/tag/delete" }).input(GitTagDeleteSchema).output(OkSchema),
    pushTag: oc.route({ method: "POST", path: "/git/{repo}/tag/push" }).input(GitTagPushSchema).output(GitActionResultSchema),
    checkout: oc.route({ method: "POST", path: "/git/{repo}/checkout" }).input(GitCheckoutSchema).output(GitActionResultSchema),
    cherryPick: oc.route({ method: "POST", path: "/git/{repo}/cherry-pick" }).input(GitCommitActionSchema).output(GitActionResultSchema),
    revert: oc.route({ method: "POST", path: "/git/{repo}/revert" }).input(GitCommitActionSchema).output(GitActionResultSchema),
    drop: oc.route({ method: "POST", path: "/git/{repo}/drop" }).input(GitCommitActionSchema).output(GitActionResultSchema),
    merge: oc.route({ method: "POST", path: "/git/{repo}/merge" }).input(GitCommitActionSchema).output(GitActionResultSchema),
    rebase: oc.route({ method: "POST", path: "/git/{repo}/rebase" }).input(GitCommitActionSchema).output(GitActionResultSchema),
    reset: oc.route({ method: "POST", path: "/git/{repo}/reset" }).input(GitResetSchema).output(GitActionResultSchema),
    fileDiff: oc.route({ method: "GET", path: "/git/{repo}/file-diff" }).input(GitFileDiffQuerySchema).output(FileDiffSchema),
    status: oc.route({ method: "GET", path: "/git/{repo}/status" }).input(RepoParamSchema).output(GitStatusSchema),
    commit: oc.route({ method: "POST", path: "/git/{repo}/commit" }).input(CommitSchema).output(CommitResultSchema),
    discard: oc.route({ method: "POST", path: "/git/{repo}/discard" }).input(DiscardSchema).output(OkSchema),
    // Index moves. Per-path, worktree untouched, so they need no checkpoint and can't fail destructively —
    // git's own error (an unmatched pathspec) propagates.
    stage: oc.route({ method: "POST", path: "/git/{repo}/stage" }).input(GitStageSchema).output(OkSchema),
    unstage: oc.route({ method: "POST", path: "/git/{repo}/unstage" }).input(GitStageSchema).output(OkSchema),
    // Local branch management for the switcher. `branches` also carries per-branch ahead/behind, so the list
    // is enough to render sync state without a call per branch. Checkout is above (it moves HEAD, so it is
    // checkpointed with the other HEAD-movers).
    branches: oc.route({ method: "GET", path: "/git/{repo}/branches" }).input(RepoParamSchema).output(GitBranchesSchema),
    createBranchAt: oc.route({ method: "POST", path: "/git/{repo}/branches" }).input(GitBranchCreateAtSchema).output(OkSchema),
    deleteBranch: oc.route({ method: "POST", path: "/git/{repo}/branches/delete" }).input(GitBranchDeleteSchema).output(OkSchema),
    // Remote sync. All three report a GitActionResult rather than throwing: no remote, no credentials and a
    // non-fast-forwardable pull are ORDINARY outcomes the panel renders, not 500s. `remote` is the read
    // (ahead/behind as of the last fetch — hence the Fetch button) the sync bar polls.
    remote: oc.route({ method: "GET", path: "/git/{repo}/remote" }).input(RepoParamSchema).output(GitRemoteStateSchema),
    fetch: oc.route({ method: "POST", path: "/git/{repo}/fetch" }).input(RepoParamSchema).output(GitActionResultSchema),
    pull: oc.route({ method: "POST", path: "/git/{repo}/pull" }).input(RepoParamSchema).output(GitActionResultSchema),
    push: oc.route({ method: "POST", path: "/git/{repo}/push" }).input(PushSchema).output(GitActionResultSchema),
    files: oc.route({ method: "GET", path: "/git/{repo}/files" }).input(RepoParamSchema).output(GitFilesSchema),
    readFile: oc.route({ method: "GET", path: "/git/{repo}/file" }).input(GitFileQuerySchema).output(GitFileSchema),
    writeFile: oc.route({ method: "PUT", path: "/git/{repo}/file" }).input(GitFileWriteSchema).output(OkSchema),
    // Write + commit-that-path-only + push, as one step with one answer. Reports rather than throws for the
    // same reason the remote trio above does: no remote, no credentials and "you are on a side branch" are
    // ordinary outcomes a screen renders, not 500s.
    publishFile: oc.route({ method: "POST", path: "/git/{repo}/publish-file" }).input(GitPublishFileSchema).output(GitPublishFileResultSchema),
};
