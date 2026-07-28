import { oc } from "@orpc/contract";
import {
    CommitMessageDraftSchema,
    CommitMessageSchema,
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
    GitRemoteStateSchema,
    GitReposSchema,
    GitResetSchema,
    GitStageSchema,
    GitStatusSchema,
    GitTagCreateSchema,
    OkSchema,
    PushSchema,
    RepoParamSchema,
} from "../schemas.js";

// Per-repo git ops over the workspace repos: "root" (the /work repo) plus every discovered repo under /work
// ({repo} is the repo's root-relative dir, URL-encoded). An unknown {repo} is a handler-thrown
// NOT_FOUND; a path that escapes the repo is a BAD_REQUEST. `changes` is the workspace-wide review set the
// Changes panel renders; commit/discard take optional `paths` for per-file actions.
export const gitContract = {
    changes: oc.route({ method: "GET", path: "/git/changes" }).output(GitChangesSchema),
    // Drafts a commit message for what the commit box is about to record, on the sandbox's quick model (the
    // cheap rung — see quick-model.ts). Workspace-wide like `changes` and for the same reason: one commit box,
    // one message, every staged repo. POST because it spends a model call, not because it writes anything.
    commitMessage: oc.route({ method: "POST", path: "/git/commit-message" }).input(CommitMessageDraftSchema).output(CommitMessageSchema),
    // The git-history graph over one repo's real commits: the repo list (for the tree affordance + switcher),
    // one repo's commit log, and lazy per-commit detail (changed files, then a file's before/after AT the
    // commit). Read-only — commit/discard on the working tree stay the write path (above).
    repos: oc.route({ method: "GET", path: "/git/repos" }).output(GitReposSchema),
    log: oc.route({ method: "GET", path: "/git/{repo}/log" }).input(GitLogQuerySchema).output(GitLogSchema),
    commitDiff: oc.route({ method: "GET", path: "/git/{repo}/commit-diff" }).input(GitCommitDiffQuerySchema).output(GitCommitDiffSchema),
    commitFileDiff: oc.route({ method: "GET", path: "/git/{repo}/commit-file-diff" }).input(GitCommitFileDiffQuerySchema).output(FileDiffSchema),
    // Write actions from the graph's commit context menu (VSCode "Git Graph" parity). Non-destructive refs
    // (branch/tag) return Ok and let git's errors propagate; the sequence + HEAD-moving ops return a
    // GitActionResult so a conflict/clean-apply failure is a value, not a 500. Read routes above.
    createBranch: oc.route({ method: "POST", path: "/git/{repo}/branch" }).input(GitBranchCreateSchema).output(OkSchema),
    createTag: oc.route({ method: "POST", path: "/git/{repo}/tag" }).input(GitTagCreateSchema).output(OkSchema),
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
};
