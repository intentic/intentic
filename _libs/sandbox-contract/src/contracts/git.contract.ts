import { oc } from "@orpc/contract";
import {
    CommitResultSchema,
    CommitSchema,
    GitFileQuerySchema,
    GitFileSchema,
    GitFilesSchema,
    GitFileWriteSchema,
    GitStatusSchema,
    OkSchema,
    PushSchema,
    RepoParamSchema,
} from "../schemas.js";

// Per-repo git ops over the three workspace repos (intent / desired-state / app). An unknown {repo} is a
// handler-thrown NOT_FOUND; a path that escapes the repo is a BAD_REQUEST.
export const gitContract = {
    status: oc.route({ method: "GET", path: "/git/{repo}/status" }).input(RepoParamSchema).output(GitStatusSchema),
    commit: oc.route({ method: "POST", path: "/git/{repo}/commit" }).input(CommitSchema).output(CommitResultSchema),
    push: oc.route({ method: "POST", path: "/git/{repo}/push" }).input(PushSchema).output(OkSchema),
    files: oc.route({ method: "GET", path: "/git/{repo}/files" }).input(RepoParamSchema).output(GitFilesSchema),
    readFile: oc.route({ method: "GET", path: "/git/{repo}/file" }).input(GitFileQuerySchema).output(GitFileSchema),
    writeFile: oc.route({ method: "PUT", path: "/git/{repo}/file" }).input(GitFileWriteSchema).output(OkSchema),
};
