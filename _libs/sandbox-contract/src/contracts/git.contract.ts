import { oc } from "@orpc/contract";
import {
    CommitResultSchema,
    CommitSchema,
    DiscardSchema,
    FileDiffSchema,
    GitChangesSchema,
    GitFileDiffQuerySchema,
    GitFileQuerySchema,
    GitFileSchema,
    GitFilesSchema,
    GitFileWriteSchema,
    GitStatusSchema,
    OkSchema,
    PushSchema,
    RepoParamSchema,
} from "../schemas.js";

// Per-repo git ops over the workspace repos: "root" (the /work repo) plus every directory under
// /work/repositories (intent / desired-state / app + extra clones). An unknown {repo} is a handler-thrown
// NOT_FOUND; a path that escapes the repo is a BAD_REQUEST. `changes` is the workspace-wide review set the
// Changes panel renders; commit/discard take optional `paths` for per-file actions.
export const gitContract = {
    changes: oc.route({ method: "GET", path: "/git/changes" }).output(GitChangesSchema),
    fileDiff: oc.route({ method: "GET", path: "/git/{repo}/file-diff" }).input(GitFileDiffQuerySchema).output(FileDiffSchema),
    status: oc.route({ method: "GET", path: "/git/{repo}/status" }).input(RepoParamSchema).output(GitStatusSchema),
    commit: oc.route({ method: "POST", path: "/git/{repo}/commit" }).input(CommitSchema).output(CommitResultSchema),
    discard: oc.route({ method: "POST", path: "/git/{repo}/discard" }).input(DiscardSchema).output(OkSchema),
    push: oc.route({ method: "POST", path: "/git/{repo}/push" }).input(PushSchema).output(OkSchema),
    files: oc.route({ method: "GET", path: "/git/{repo}/files" }).input(RepoParamSchema).output(GitFilesSchema),
    readFile: oc.route({ method: "GET", path: "/git/{repo}/file" }).input(GitFileQuerySchema).output(GitFileSchema),
    writeFile: oc.route({ method: "PUT", path: "/git/{repo}/file" }).input(GitFileWriteSchema).output(OkSchema),
};
