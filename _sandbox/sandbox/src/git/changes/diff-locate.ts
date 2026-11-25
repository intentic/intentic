import { spawn } from "node:child_process";
import { join } from "node:path";
import { Readable } from "node:stream";
import { type DiffSourceQuery, DiffSourceQuerySchema } from "@intentic/sandbox-contract/schemas/diff";
import { GIT_GLOBAL_ARGS, gitBytes } from "@intentic/base/git";
import { untranslatedEnv } from "@intentic/base/process";
import { webStream } from "@intentic/base/web-stream";
import type { Services } from "../../composition.js";
import { gitViewRepoDir } from "../review/git-view.js";
import { isValidRepoId } from "../../workspace/layout/repo-discovery.js";
import { MAX_RAW_BYTES } from "../../workspace/files/workspace-files-download.js";
import { isControlPlanePath, isReviewableStatePath, resolveWithin } from "../../workspace/files/workspace-files-paths.js";

export type DiffLocatorDeps = Pick<Services, "files" | "workspace" | "agents" | "agentWorktrees" | "history" | "branchCheckouts">;

// Where one side of a named diff lives, and its bytes: the one resolver behind every route that answers a diff with
// something other than its text (bytes on /diff/raw, derived text on /diff/derived). Each source mirrors the pairing
// its JSON diff uses (changes-diff.ts, agents.routes.ts, history.ts), so a row and its sides agree.

// A blob at a rev-spec in a git dir, or a file on disk (the worktree side, with no object yet).
export type BlobLocation = { readonly dir: string; readonly spec: string } | { readonly file: string };

export type Which = "before" | "after";

// A refusal carrying the HTTP status to answer with; thrown so each resolution stays a straight line, not a chain of
// early returns. Each route maps it to its own error vocabulary.
export class DiffLocateError extends Error {
    constructor(
        readonly status: 400 | 404 | 413,
        message: string,
    ) {
        super(message);
    }
}

// `cat-file -s` prints a decimal byte count only; this buffer size is generous for that.
const SIZE_OUTPUT_BYTES = 64;

// A query string as the typed source; the schema's own complaint is the 400's text.
export const parseDiffSourceQuery = (query: URLSearchParams): DiffSourceQuery => {
    const parsed = DiffSourceQuerySchema.safeParse(Object.fromEntries(query));
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new DiffLocateError(400, issue === undefined ? "invalid diff source" : `${issue.path.join(".")}: ${issue.message}`);
    }
    return parsed.data;
};

// A blob's size at a rev-spec, asked before anything is read; a missing one (git exits non-zero) 404s instead of
// answering an empty body.
const blobSize = async (dir: string, spec: string): Promise<number> => {
    const size = await gitBytes(dir, ["cat-file", "-s", spec], SIZE_OUTPUT_BYTES)
        .then((stdout) => Number(stdout.toString().trim()))
        .catch(() => Number.NaN);
    if (Number.isNaN(size)) {
        throw new DiffLocateError(404, "not found");
    }
    return size;
};

// Reads a blob at a rev-spec whole, sized first so an oversized object is refused before buffering.
const readBlob = async (dir: string, spec: string): Promise<Buffer> => {
    if ((await blobSize(dir, spec)) > MAX_RAW_BYTES) {
        throw new DiffLocateError(413, "file too large");
    }
    return gitBytes(dir, ["cat-file", "-p", spec], MAX_RAW_BYTES);
};

// A side sized and opened rather than read: its bytes leave as they are read, so its size costs the daemon nothing.
export interface OpenedSide {
    readonly size: number;
    readonly body: () => ReadableStream<Uint8Array>;
}

// A blob piped out of `git cat-file` as git writes it.
const openBlob = async (dir: string, spec: string): Promise<OpenedSide> => ({
    size: await blobSize(dir, spec),
    body: () => {
        // allow(process-tiers): a blob streamed as git writes it, which exec's buffered stdout cannot do; it lives as long
        // as its reader reads, and a reader that stops closes the pipe, which ends it.
        const git = spawn("git", [...GIT_GLOBAL_ARGS, "-C", dir, "cat-file", "-p", spec], { env: untranslatedEnv(process.env), stdio: ["ignore", "pipe", "ignore"] });
        return webStream<Uint8Array>(Readable.toWeb(git.stdout));
    },
});

// The worktree side, opened the way /workspace/raw opens a file (and read whole for a route that reads it here); a
// deleted file 404s honestly.
const openWorktreeFile = async (files: DiffLocatorDeps["files"], file: string): Promise<OpenedSide> => {
    const opened = await files.open(file);
    if (opened === undefined) {
        throw new DiffLocateError(404, "not found");
    }
    return opened;
};
const readWorktreeFile = async (files: DiffLocatorDeps["files"], file: string): Promise<Buffer> => {
    const opened = await openWorktreeFile(files, file);
    if (opened.size > MAX_RAW_BYTES) {
        throw new DiffLocateError(413, "file too large");
    }
    return Buffer.from(await new Response(opened.body()).arrayBuffer());
};

export interface DiffLocator {
    // Where the named side lives; undefined means that side never existed for this file (a checkpoint's added file).
    readonly locate: (query: DiffSourceQuery, which: Which) => Promise<BlobLocation | undefined>;
    // The side's bytes, whole, for a route that reads them here (its derived text); refuses past MAX_RAW_BYTES and 404s a
    // side that is not there.
    readonly read: (located: BlobLocation) => Promise<Buffer>;
    // The side's bytes as a stream, for a route that hands them on (/diff/raw): any size, and the same 404.
    readonly open: (located: BlobLocation) => Promise<OpenedSide>;
}

const checkoutRoot = (dir: string, repo: string): string => repo === "root" ? dir : join(dir, ...repo.split("/").map(() => ".."));

export const createDiffLocator = (services: DiffLocatorDeps): DiffLocator => {
    // Not the git routes' `repoDir`: that one heals the --separate-git-dir pointer (a write), and these routes only ever
    // run after their JSON sibling already did that.
    const repoDir = (repo: string): string => {
        if (repo === "root") {
            return services.workspace.root;
        }
        if (!isValidRepoId(repo)) {
            throw new DiffLocateError(404, "unknown repo");
        }
        return join(services.workspace.root, repo);
    };

    // Bars a path from leaving its repo or reaching the control plane, with the same review carve-out as git.routes'
    // guardDiffPath: a tracked control-plane entry the JSON diff shows must not 404 as a picture.
    const guardPath = (dir: string, path: string, root = services.workspace.root): string => {
        const target = resolveWithin(dir, path);
        if (target === undefined) {
            throw new DiffLocateError(400, "invalid path");
        }
        if (isControlPlanePath(root, target) && !isReviewableStatePath(root, target)) {
            throw new DiffLocateError(404, "not found");
        }
        return target;
    };

    // Uncommitted work (the Changes panel); mirrors stagedFileDiff/unstagedFileDiff/conflictedFileDiff's pairs exactly.
    // `:0:` is the index at stage 0; a conflict has none, so it reads HEAD instead.
    const workingLocation = async (query: Extract<DiffSourceQuery, { source: "working" }>, which: Which): Promise<BlobLocation> => {
        const dir = query.view === undefined ? repoDir(query.repo) : await gitViewRepoDir(services, query.view, query.repo);
        const file = guardPath(dir, query.path, query.view === undefined ? services.workspace.root : checkoutRoot(dir, query.repo));
        if (query.side === "staged") {
            return { dir, spec: which === "before" ? `HEAD:${query.path}` : `:0:${query.path}` };
        }
        if (query.side === "unstaged") {
            return which === "before" ? { dir, spec: `:0:${query.path}` } : { file };
        }
        return which === "before" ? { dir, spec: `HEAD:${query.path}` } : { file };
    };

    // An agent's work against its review base; archived agents have no checkout, so both sides come from blobs in the
    // main repo, mirroring agents.routes.ts's split for the JSON diff.
    const agentLocation = (query: Extract<DiffSourceQuery, { source: "agent" }>, which: Which): BlobLocation => {
        const entry = services.agents.entry(query.agent);
        if (entry === undefined) {
            throw new DiffLocateError(404, "unknown agent");
        }
        const worktree = entry.placement;
        if (worktree.kind === "main") {
            throw new DiffLocateError(400, "workspace conversation has no isolated diff");
        }
        const composed = worktree.repos.find((candidate) => candidate.repo === query.repo);
        if (composed === undefined) {
            throw new DiffLocateError(404, "repo not in this agent's composition");
        }
        if (entry.archivedAt !== undefined) {
            const main = services.agentWorktrees.mainDir(query.repo);
            guardPath(main, query.path);
            return { dir: main, spec: which === "before" ? `${composed.base}:${query.path}` : `${worktree.branch}:${query.path}` };
        }
        const dir = services.agentWorktrees.worktreeDir(entry.id, query.repo);
        const file = guardPath(dir, query.path);
        return which === "before" ? { dir, spec: `${composed.base}:${query.path}` } : { file };
    };

    // A commit against its first parent, the same pairing commitFileDiff uses. The sha is the only wire value reaching
    // git's rev-spec parser; the schema holds it to hex, so it can't be a `--flag` or `..` range.
    const commitLocation = (query: Extract<DiffSourceQuery, { source: "commit" }>, which: Which): BlobLocation => {
        const dir = repoDir(query.repo);
        guardPath(dir, query.path);
        return { dir, spec: which === "before" ? `${query.sha}^:${query.path}` : `${query.sha}:${query.path}` };
    };

    return {
        locate: async (query, which) => {
            if (query.source === "working") {
                return workingLocation(query, which);
            }
            if (query.source === "agent") {
                return agentLocation(query, which);
            }
            if (query.source === "commit") {
                return commitLocation(query, which);
            }
            // Delegates to history.ts; undefined means that checkpoint's file never had this side.
            return services.history.fileBlob(query.snapshot, query.scope, query.path, which);
        },
        read: (located) => ("file" in located ? readWorktreeFile(services.files, located.file) : readBlob(located.dir, located.spec)),
        open: (located) => ("file" in located ? openWorktreeFile(services.files, located.file) : openBlob(located.dir, located.spec)),
    };
};
