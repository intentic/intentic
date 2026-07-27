import { join } from "node:path";
import { gitBytes } from "@intentic/scaffold";
import { Hono } from "hono";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { isValidRepoId } from "../workspace/repo-discovery.js";
import { contentTypeForPath, isControlPlanePath, MAX_RAW_BYTES, resolveWithin } from "../workspace/workspace-files.js";

/* THE BYTES BEHIND A BINARY DIFF — /diff/raw, the sibling of /workspace/raw, and for the same reason: an image
 * is rendered from its bytes, and the JSON diff contract can only carry text. Every file-diff route in this
 * daemon reports `binary: true` and ships nothing for a PNG, which left every review surface in the browser
 * with the same dead end ("Binary file — no text diff to show.") over a file the workspace file view displays
 * without trouble. This route is what closes that gap: same auth, same 25 MiB cap, same content-type table.
 *
 * ONE ROUTE, FOUR SOURCES, because there are four places a diff comes from and a reviewer cannot tell them
 * apart — the Changes panel, an agent's review, a commit in the graph, a checkpoint — and a viewer that worked
 * in one of them would read as broken in the other three. `source` picks which, and each branch resolves the
 * SAME rev-specs its JSON counterpart reads (git/changes.ts, agents.routes.ts, history.ts): a staged row is
 * HEAD↔index there, so it is HEAD↔index here, and the image never disagrees with the row it was opened from.
 *
 * The client sends no rev-spec and no directory — only the identifiers it already used to fetch the JSON diff.
 * Everything git is asked to resolve is built on this side, so the route's reach is exactly the four diffs the
 * contract already exposes.
 *
 * WHICH SIDES EXIST is the caller's business, not this route's: a row's status says it (an added file has no
 * before, a deleted one no after), so a side with no blob is a plain 404 rather than a negotiated shape. */

// Where one side's bytes live: a blob at a rev-spec inside a git dir (bare dirs included — `git -C` reads those
// too), or a file on disk, which is the worktree side of an uncommitted change and has no object yet.
type BlobLocation = { readonly dir: string; readonly spec: string } | { readonly file: string };

// A refusal with the status the route answers it with — the four sources reject for the same handful of
// reasons, and throwing keeps each resolution a straight line instead of a chain of early returns.
class DiffRawError extends Error {
    constructor(
        readonly status: 400 | 404 | 413,
        message: string,
    ) {
        super(message);
    }
}

// Which of the two ends of the comparison is being asked for.
type Which = "before" | "after";

// `cat-file -s` prints a decimal byte count and nothing else — a buffer this size is already absurdly generous.
const SIZE_OUTPUT_BYTES = 64;

const required = (value: string | null, name: string): string => {
    if (value === null || value === "") {
        throw new DiffRawError(400, `${name} is required`);
    }
    return value;
};

// A blob at a rev-spec. Sized first, so an oversized object is refused rather than buffered into the daemon's
// heap — and so an ABSENT one (git exits non-zero) is the 404 a side the file never had deserves, rather than
// an empty body the browser would render as a corrupt image.
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
    // The worktree side, through the same file service /workspace/raw reads — the file is gone the moment the
    // agent (or the user) deletes it, which is the other honest 404 here.
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

    // Deliberately NOT the git routes' `repoDir`: that one heals the repo's --separate-git-dir pointer, which is
    // a WRITE, and this route only ever runs after its JSON sibling has already fetched (and healed) the same
    // repo. A read route that repairs the thing it reads is a surprise nobody asked for.
    const repoDir = (repo: string): string => {
        if (repo === "root") {
            return services.workspace.root;
        }
        if (!isValidRepoId(repo)) {
            throw new DiffRawError(404, "unknown repo");
        }
        return join(services.workspace.root, repo);
    };

    // The two floors every file surface in this daemon applies: a path may not climb out of its repo, and it may
    // not reach the daemon's control plane — for repo "root" that dir IS the workspace, so without the second
    // check this route would be the way around isControlPlanePath.
    const guardPath = (dir: string, path: string): string => {
        const target = resolveWithin(dir, path);
        if (target === undefined) {
            throw new DiffRawError(400, "invalid path");
        }
        if (isControlPlanePath(services.workspace.root, target)) {
            throw new DiffRawError(404, "not found");
        }
        return target;
    };

    // Uncommitted work in a workspace repo — the Changes panel. The spec pairs mirror stagedFileDiff /
    // unstagedFileDiff / conflictedFileDiff exactly, `:0:` being the index at stage 0 (an unmerged path has no
    // stage 0, which is why a conflict reads HEAD instead).
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

    // One agent's work against the base its review is listed against. Archived agents have no checkout left, so
    // both sides are blobs read from the main repo — the same split agents.routes.ts makes for the JSON diff.
    const agentLocation = (query: URLSearchParams, path: string, which: Which): BlobLocation => {
        const id = required(query.get("agent"), "agent");
        const repo = required(query.get("repo"), "repo");
        const entry = services.agents.entry(id);
        if (entry === undefined) {
            throw new DiffRawError(404, "unknown agent");
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

    // A commit in the graph, against its first parent — commitFileDiff's own pairing.
    const commitLocation = (query: URLSearchParams, path: string, which: Which): BlobLocation => {
        const dir = repoDir(required(query.get("repo"), "repo"));
        guardPath(dir, path);
        const sha = required(query.get("sha"), "sha");
        // The one identifier that reaches git's rev-spec parser from the wire. Held to the contract's own sha
        // shape (ShaSchema) so it can only ever name an object, never a `--flag` or a `..` range.
        if (!/^[0-9a-f]{4,64}$/.test(sha)) {
            throw new DiffRawError(400, "invalid sha");
        }
        return { dir, spec: which === "before" ? `${sha}^:${path}` : `${sha}:${path}` };
    };

    // Which diff the two identifiers name, and where in git that side of it lives. Every branch resolves the
    // same pair its JSON counterpart does; checkpoints keep theirs inside history.ts, which owns the bare scope
    // repos and the previous-VISIBLE-checkpoint rule that decides what a checkpoint is diffed against at all.
    // undefined comes back only from there, and only for a side that checkpoint's file never had.
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

            // Wrap in a fresh Uint8Array so the body type is exactly Uint8Array<ArrayBuffer> (a Buffer's backing
            // is ArrayBufferLike, which Hono's body type rejects); bounded above, so the copy is cheap. The
            // content type comes from the PATH, which is what tells an <img> from an <object> in the browser.
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
