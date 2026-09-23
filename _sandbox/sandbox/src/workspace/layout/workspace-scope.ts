import { access } from "node:fs/promises";
import { type ArchivePath, archivePrefixOf, archiveRootOf, ConversationIdSchema, type WorkspaceChildren } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { PersistedAgent } from "../../agents/registry/agents-store.js";
import { archiveChildrenOf, archiveMemberPath, isBrowsableArchiveFile } from "../files/workspace-archive-browse.js";
import { isControlPlanePath, realWithin, resolveWithin } from "../files/workspace-files-paths.js";

// Resolves where a read really lands, for every file-serving route; downstream just takes the answer. Two questions in
// one place: whose copy of the workspace it means, and whether it reads through an archive into that archive's
// unpacked copy.
// Reads only: no write route's schema carries a scope field, so the file API can't write into a checkout mid-turn, and
// nothing is ever written back into an archive.

export interface WorkspaceScopeDeps {
    // The shared /work tree: the answer when no conversation is named, and the fallback.
    readonly main: string;
    readonly entry: (id: string) => PersistedAgent | undefined;
    readonly worktreeDir: (id: string) => string;
}

const present = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

// Resolves relPath inside root: an escaping path is BAD_REQUEST, the daemon's private state is NOT_FOUND (not
// FORBIDDEN).
// The escape guard runs twice: lexically (resolveWithin) and on disk (realWithin, for a symlink); both are BAD_REQUEST.
export const containedIn = async (root: string, relPath: string): Promise<string> => {
    const target = resolveWithin(root, relPath);
    if (target === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
    }
    if (isControlPlanePath(root, target)) {
        throw new ORPCError("NOT_FOUND", { message: "not found" });
    }
    if ((await realWithin(root, target)) === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
    }
    return target;
};

// A non-isolated conversation resolves to the shared tree rather than failing; /work genuinely is its tree.
// A retired checkout is the hard stop: archiving keeps the branch but drops the checkout, distinct from a missing file.
export const workspaceRootFor = async (deps: WorkspaceScopeDeps, agent: string | undefined): Promise<string> => {
    if (agent === undefined) {
        return deps.main;
    }
    // Byte routes read the id off a query string themselves; the guard lives here so no route can skip it.
    if (!ConversationIdSchema.safeParse(agent).success) {
        throw new ORPCError("BAD_REQUEST", { message: "invalid agent" });
    }
    const entry = deps.entry(agent);
    if (entry === undefined) {
        throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
    }
    // No branch, no worktree of its own.
    if (entry.placement.kind === "main") {
        return deps.main;
    }
    const dir = deps.worktreeDir(agent);
    if (!(await present(dir))) {
        throw new ORPCError("PRECONDITION_FAILED", {
            message: "this agent's files were cleaned up when it was archived, its work is kept on its branch, in its changes",
        });
    }
    return dir;
};

// Whether a path names an archive FILE in this root. Only ever asked of a segment already named like an archive, so
// an ordinary path costs no syscall.
const archiveHere =
    (root: string) =>
    (relPath: string): boolean => {
        const abs = resolveWithin(root, relPath);
        return abs !== undefined && !isControlPlanePath(root, abs) && isBrowsableArchiveFile(abs);
    };

// Where a path that reads THROUGH an archive really points, and which archive that is; undefined for an ordinary path,
// and for one that names the archive itself.
const archiveSplit = (root: string, relPath: string): ArchivePath | undefined => archivePrefixOf(relPath, archiveHere(root));

// An archive that can't be opened (too large, no tool for it, corrupt) answers with the account of why, since that is
// the only thing a reader can act on.
const asBadRequest = (failure: unknown): never => {
    throw new ORPCError("BAD_REQUEST", { message: failure instanceof Error ? failure.message : "could not open that archive" });
};

/** Whether this path reads through an archive, and so may be read but never written. */
export const insideArchive = (root: string, relPath: string): boolean => archiveSplit(root, relPath) !== undefined;

/** `containedIn`, plus the redirect into an archive's unpacked copy. Every read route resolves through this. */
export const containedForRead = async (root: string, relPath: string): Promise<string> => {
    const split = archiveSplit(root, relPath);
    if (split === undefined) {
        return containedIn(root, relPath);
    }
    const member = await archiveMemberPath(await containedIn(root, split.archive), split.inside).catch(asBadRequest);
    if (member === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
    }
    return member;
};

/**
 * A folder listing when the folder is an archive, or lives inside one; undefined when no archive is involved and the
 * caller should list the real tree.
 */
export const childrenForRead = async (root: string, relPath: string, options?: { depth?: number }): Promise<WorkspaceChildren | undefined> => {
    const split = archiveRootOf(relPath, archiveHere(root));
    if (split === undefined) {
        return undefined;
    }
    const archive = await containedIn(root, split.archive);
    return archiveChildrenOf(archive, split.archive, split.inside, options).catch(asBadRequest);
};

// Falls back to the shared tree when the path isn't in the checkout: it mirrors /work's layout but isn't a superset.
// `shared` reports which tree answered, so the reader is never guessing.
export const scopedTarget = async (
    deps: WorkspaceScopeDeps,
    agent: string | undefined,
    relPath: string,
): Promise<{ readonly target: string; readonly shared: boolean }> => {
    const root = await workspaceRootFor(deps, agent);
    const scoped = await containedForRead(root, relPath);
    if (root === deps.main || (await present(scoped))) {
        return { target: scoped, shared: root === deps.main };
    }
    return { target: await containedForRead(deps.main, relPath), shared: true };
};
