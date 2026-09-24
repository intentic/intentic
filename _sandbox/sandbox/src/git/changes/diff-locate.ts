import { join } from "node:path";
import { type DiffSourceQuery, DiffSourceQuerySchema } from "@intentic/sandbox-contract";
import { gitBytes } from "@intentic/scaffold";
import type { Services } from "../../composition.js";
import { isValidRepoId } from "../../workspace/layout/repo-discovery.js";
import { MAX_RAW_BYTES } from "../../workspace/files/workspace-files-download.js";
import { isControlPlanePath, isReviewableStatePath, resolveWithin } from "../../workspace/files/workspace-files-paths.js";

export type DiffLocatorDeps = Pick<Services, "files" | "workspace" | "agents" | "agentWorktrees" | "history">;

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

// Reads a blob at a rev-spec, sized first so an oversized object is refused before buffering, and a missing one (git
// exits non-zero) 404s instead of returning an empty body.
const readBlob = async (dir: string, spec: string): Promise<Buffer> => {
    const size = await gitBytes(dir, ["cat-file", "-s", spec], SIZE_OUTPUT_BYTES)
        .then((stdout) => Number(stdout.toString().trim()))
        .catch(() => Number.NaN);
    if (Number.isNaN(size)) {
        throw new DiffLocateError(404, "not found");
    }
    if (size > MAX_RAW_BYTES) {
        throw new DiffLocateError(413, "file too large");
    }
    return gitBytes(dir, ["cat-file", "-p", spec], MAX_RAW_BYTES);
};

export interface DiffLocator {
    // Where the named side lives; undefined means that side never existed for this file (a checkpoint's added file).
    readonly locate: (query: DiffSourceQuery, which: Which) => Promise<BlobLocation | undefined>;
    // The side's bytes, whole; refuses past MAX_RAW_BYTES and 404s a side that is not there.
    readonly read: (located: BlobLocation) => Promise<Buffer>;
}

export const createDiffLocator = (services: DiffLocatorDeps): DiffLocator => {
    // The worktree side, opened the way /workspace/raw opens a file and read whole, since the other side is a whole
    // blob; a deleted file 404s honestly.
    const readWorktreeFile = async (file: string): Promise<Buffer> => {
        const opened = await services.files.open(file);
        if (opened === undefined) {
            throw new DiffLocateError(404, "not found");
        }
        if (opened.size > MAX_RAW_BYTES) {
            throw new DiffLocateError(413, "file too large");
        }
        return Buffer.from(await new Response(opened.body()).arrayBuffer());
    };

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
    const guardPath = (dir: string, path: string): string => {
        const target = resolveWithin(dir, path);
        if (target === undefined) {
            throw new DiffLocateError(400, "invalid path");
        }
        if (isControlPlanePath(services.workspace.root, target) && !isReviewableStatePath(services.workspace.root, target)) {
            throw new DiffLocateError(404, "not found");
        }
        return target;
    };

    // Uncommitted work (the Changes panel); mirrors stagedFileDiff/unstagedFileDiff/conflictedFileDiff's pairs exactly.
    // `:0:` is the index at stage 0; a conflict has none, so it reads HEAD instead.
    const workingLocation = (query: Extract<DiffSourceQuery, { source: "working" }>, which: Which): BlobLocation => {
        const dir = repoDir(query.repo);
        const file = guardPath(dir, query.path);
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
        read: (located) => ("file" in located ? readWorktreeFile(located.file) : readBlob(located.dir, located.spec)),
    };
};
