import { oc } from "@orpc/contract";
import {
    CommitResultSchema,
    CommitSchema,
    DiscardSchema,
    FileDiffSchema,
    GitChangesSchema,
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
    GitStatusSchema,
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
    fileDiff: oc.route({ method: "GET", path: "/git/{repo}/file-diff" }).input(GitFileDiffQuerySchema).output(FileDiffSchema),
    status: oc.route({ method: "GET", path: "/git/{repo}/status" }).input(RepoParamSchema).output(GitStatusSchema),
    commit: oc.route({ method: "POST", path: "/git/{repo}/commit" }).input(CommitSchema).output(CommitResultSchema),
    discard: oc.route({ method: "POST", path: "/git/{repo}/discard" }).input(DiscardSchema).output(OkSchema),
    push: oc.route({ method: "POST", path: "/git/{repo}/push" }).input(PushSchema).output(OkSchema),
    files: oc.route({ method: "GET", path: "/git/{repo}/files" }).input(RepoParamSchema).output(GitFilesSchema),
    readFile: oc.route({ method: "GET", path: "/git/{repo}/file" }).input(GitFileQuerySchema).output(GitFileSchema),
    writeFile: oc.route({ method: "PUT", path: "/git/{repo}/file" }).input(GitFileWriteSchema).output(OkSchema),
};
