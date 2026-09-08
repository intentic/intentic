import { join } from "node:path";
import { gitBytes } from "@intentic/scaffold";
import { Hono } from "hono";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";
import { isValidRepoId } from "../../workspace/layout/repo-discovery.js";
import { contentTypeForPath, MAX_RAW_BYTES } from "../../workspace/files/workspace-files-download.js";
import { isControlPlanePath, isReviewableStatePath, resolveWithin } from "../../workspace/files/workspace-files-paths.js";

// Bytes behind a binary diff (JSON diff can't carry them); sibling of /workspace/raw. Covers all four diff sources
// (working/agent/commit/checkpoint), each resolving the same rev-specs as its JSON counterpart.

// Where one side's bytes live: a blob at a rev-spec in a git dir, or a file on disk (the worktree side, with no object
// yet).
type BlobLocation = { readonly dir: string; readonly spec: string } | { readonly file: string };

// A refusal carrying the HTTP status to answer with; thrown so each resolution stays a straight line, not a chain of
// early returns.
class DiffRawError extends Error {
    constructor(
        readonly status: 400 | 404 | 413,
        message: string,
    ) {
        super(message);
    }
}

type Which = "before" | "after";

// `cat-file -s` prints a decimal byte count only; this buffer size is generous for that.
const SIZE_OUTPUT_BYTES = 64;

const required = (value: string | null, name: string): string => {
    if (value === null || value === "") {
        throw new DiffRawError(400, `${name} is required`);
    }
    return value;
};

// Reads a blob at a rev-spec, sized first so an oversized object is refused before buffering, and a missing one (git
// exits non-zero) 404s instead of returning an empty body.
const readBlob = async (dir: string, spec: string): Promise<Buffer> => {
    const size = await gitBytes(dir, ["cat-file", "-s", spec], SIZE_OUTPUT_BYTES)
        .then((stdout) => Number(stdout.toString().trim()))
        .catch(() => Number.NaN);
    if (Number.isNaN(size)) {
        throw new DiffRawError(404, "not found");
    }
    if (size > MAX_RAW_BYTES) {
        throw new DiffRawError(413, "file too large");
    }
    return gitBytes(dir, ["cat-file", "-p", spec], MAX_RAW_BYTES);
};

export const createDiffRawRoute = (services: Services): Hono<AppEnv> => {
    // The worktree side, via the same file service /workspace/raw reads; a deleted file 404s honestly.
    const readWorktreeFile = async (file: string): Promise<Buffer> => {
        const size = await services.files.size(file);
        if (size === undefined) {
            throw new DiffRawError(404, "not found");
        }
        if (size > MAX_RAW_BYTES) {
            throw new DiffRawError(413, "file too large");
        }
        const bytes = await services.files.readBytes(file);
        if (bytes === undefined) {
            throw new DiffRawError(404, "not found");
        }
        return bytes;
    };

    // Not the git routes' `repoDir`: that one heals the --separate-git-dir pointer (a write), and this route only ever
    // runs after its JSON sibling already did that.
    const repoDir = (repo: string): string => {
        if (repo === "root") {
            return services.workspace.root;
        }
        if (!isValidRepoId(repo)) {
            throw new DiffRawError(404, "unknown repo");
        }
        return join(services.workspace.root, repo);
    };

    // Bars a path from leaving its repo or reaching the control plane, with the same review carve-out as git.routes'
    // guardDiffPath: a tracked control-plane entry the JSON diff shows must not 404 as a picture.
    const guardPath = (dir: string, path: string): string => {
        const target = resolveWithin(dir, path);
        if (target === undefined) {
            throw new DiffRawError(400, "invalid path");
        }
        if (isControlPlanePath(services.workspace.root, target) && !isReviewableStatePath(services.workspace.root, target)) {
            throw new DiffRawError(404, "not found");
        }
        return target;
    };

    // Uncommitted work (the Changes panel); mirrors stagedFileDiff/unstagedFileDiff/conflictedFileDiff's pairs exactly.
    // `:0:` is the index at stage 0; a conflict has none, so it reads HEAD instead.
    const workingLocation = (query: URLSearchParams, path: string, which: Which): BlobLocation => {
        const dir = repoDir(required(query.get("repo"), "repo"));
        const file = guardPath(dir, path);
        const row = required(query.get("side"), "side");
        if (row === "staged") {
            return { dir, spec: which === "before" ? `HEAD:${path}` : `:0:${path}` };
        }
        if (row === "unstaged") {
            return which === "before" ? { dir, spec: `:0:${path}` } : { file };
        }
        if (row === "conflicted") {
            return which === "before" ? { dir, spec: `HEAD:${path}` } : { file };
        }
        throw new DiffRawError(400, "unknown side");
    };

    // An agent's work against its review base; archived agents have no checkout, so both sides come from blobs in the
    // main repo, mirroring agents.routes.ts's split for the JSON diff.
    const agentLocation = (query: URLSearchParams, path: string, which: Which): BlobLocation => {
        const id = required(query.get("agent"), "agent");
        const repo = required(query.get("repo"), "repo");
        const entry = services.agents.entry(id);
        if (entry === undefined) {
            throw new DiffRawError(404, "unknown agent");
        }
        if (entry.branch === undefined) {
            throw new DiffRawError(400, "workspace conversation has no isolated diff");
        }
        const composed = entry.repos.find((candidate) => candidate.repo === repo);
        if (composed === undefined) {
            throw new DiffRawError(404, "repo not in this agent's composition");
        }
        if (entry.archivedAt !== undefined) {
            const main = services.agentWorktrees.mainDir(repo);
            guardPath(main, path);
            return { dir: main, spec: which === "before" ? `${composed.base}:${path}` : `${entry.branch}:${path}` };
        }
        const dir = services.agentWorktrees.worktreeDir(entry.id, repo);
        const file = guardPath(dir, path);
        return which === "before" ? { dir, spec: `${composed.base}:${path}` } : { file };
    };

    // A commit against its first parent, the same pairing commitFileDiff uses.
    const commitLocation = (query: URLSearchParams, path: string, which: Which): BlobLocation => {
        const dir = repoDir(required(query.get("repo"), "repo"));
        guardPath(dir, path);
        const sha = required(query.get("sha"), "sha");
        // Only wire value reaching git's rev-spec parser; held to ShaSchema so it can't be a `--flag` or `..` range.
        if (!/^[0-9a-f]{4,64}$/.test(sha)) {
            throw new DiffRawError(400, "invalid sha");
        }
        return { dir, spec: which === "before" ? `${sha}^:${path}` : `${sha}:${path}` };
    };

    // Resolves where one side of the named diff lives; every branch mirrors its JSON counterpart's pairing. Checkpoints
    // delegate to history.ts; undefined means that checkpoint's file never had this side.
    const locate = async (query: URLSearchParams, path: string, which: Which): Promise<BlobLocation | undefined> => {
        const source = query.get("source");
        if (source === "working") {
            return workingLocation(query, path, which);
        }
        if (source === "agent") {
            return agentLocation(query, path, which);
        }
        if (source === "commit") {
            return commitLocation(query, path, which);
        }
        if (source === "checkpoint") {
            return services.history.fileBlob(required(query.get("snapshot"), "snapshot"), required(query.get("scope"), "scope"), path, which);
        }
        throw new DiffRawError(400, "unknown source");
    };

    const app = new Hono<AppEnv>();

    app.get("/diff/raw", async (c) => {
        const query = new URL(c.req.url).searchParams;
        try {
            const path = required(query.get("path"), "path");
            const which = query.get("which");
            if (which !== "before" && which !== "after") {
                throw new DiffRawError(400, "which must be before or after");
            }
            const located = await locate(query, path, which);
            if (located === undefined) {
                throw new DiffRawError(404, "not found");
            }

            const bytes = "file" in located ? await readWorktreeFile(located.file) : await readBlob(located.dir, located.spec);

            // Copied into a fresh Uint8Array: Hono rejects a Buffer's ArrayBufferLike backing.
            return c.body(new Uint8Array(bytes), 200, {
                "Content-Type": contentTypeForPath(path),
                "Content-Length": String(bytes.byteLength),
            });
        } catch (error) {
            if (error instanceof DiffRawError) {
                return c.json({ error: error.message }, error.status);
            }
            throw error;
        }
    });

    return app;
};
