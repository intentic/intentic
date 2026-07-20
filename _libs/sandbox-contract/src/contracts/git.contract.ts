import { oc } from "@orpc/contract";
import {
    CommitResultSchema,
    CommitSchema,
    DiscardSchema,
    FileDiffSchema,
    GitActionResultSchema,
    GitBranchCreateSchema,
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
    GitReposSchema,
    GitResetSchema,
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
    push: oc.route({ method: "POST", path: "/git/{repo}/push" }).input(PushSchema).output(OkSchema),
    files: oc.route({ method: "GET", path: "/git/{repo}/files" }).input(RepoParamSchema).output(GitFilesSchema),
    readFile: oc.route({ method: "GET", path: "/git/{repo}/file" }).input(GitFileQuerySchema).output(GitFileSchema),
    writeFile: oc.route({ method: "PUT", path: "/git/{repo}/file" }).input(GitFileWriteSchema).output(OkSchema),
};
