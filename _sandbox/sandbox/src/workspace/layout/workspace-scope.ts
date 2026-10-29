import { posix } from "node:path";
import { discoverRepos } from "./repo-discovery.js";
import { access } from "node:fs/promises";
import { type ArchivePath, archivePrefixOf, archiveRootOf } from "@intentic/sandbox-contract/formats/archives";
import { ConversationIdSchema } from "@intentic/sandbox-contract/schemas/agent";
import type { WorkspaceChildren } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { ORPCError } from "@orpc/server";
import type { PersistedAgent } from "../../conversations/registry/agents-store.js";
import { archiveChildrenOf, archiveMemberPath, isBrowsableArchiveFile } from "../files/archive/workspace-archive-browse.js";
import { holdsControlPlane, isControlPlanePath, resolveWithin, resolveWorkspacePath } from "../files/workspace-files-paths.js";
import { branchRegion, branchScopeOf, type BranchViews, branchViewRoot, type ReadScope } from "./branch-view.js";

// Resolves where a read really lands, for every file-serving route; downstream just takes the answer. Two questions in
// one place: whose copy of the workspace it means (the shared tree, a conversation's checkout, or a branch the shared
// tree is not on: branch-view.ts), and whether it reads through an archive into that archive's unpacked copy.
// Writes use workspaceWriteRootFor to enforce repository ownership. Nothing is written back into an archive.

export interface WorkspaceScopeDeps {
    // The shared /work tree: the answer when no conversation is named, and the fallback.
    readonly main: string;
    readonly entry: (id: string) => PersistedAgent | undefined;
    readonly worktreeDir: (id: string) => string;
    // The checkouts kept of branches the shared tree is not on, for a branch scope.
    readonly branches: BranchViews;
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
// FORBIDDEN). Both are asked lexically and on disk (resolveWorkspacePath), so a symlinked folder leads neither out of
// root nor into its control plane.
export const containedIn = async (root: string, relPath: string): Promise<string> => {
    const resolved = await resolveWorkspacePath(root, relPath);
    if (resolved.kind === "outside") {
        throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
    }
    if (resolved.kind === "controlPlane") {
        throw new ORPCError("NOT_FOUND", { message: "not found" });
    }
    return resolved.path;
};

// Refuses a delete, a move or a copy onto a folder the daemon's private state sits in (holdsControlPlane): `.intentic`
// itself and its groups are opened and written inside like any folder, but stay where they are, for anyone.
export const refuseKeptFolder = async (root: string, absPath: string): Promise<void> => {
    if (await holdsControlPlane(root, absPath)) {
        throw new ORPCError("BAD_REQUEST", { message: "this folder holds the sandbox's own settings and keys, so it stays where it is" });
    }
};

// A non-isolated conversation resolves to the shared tree rather than failing; /work genuinely is its tree.
// A retired checkout is the hard stop: archiving keeps the branch but drops the checkout, distinct from a missing file.
// A branch scope answers with the branch's workspace-shaped checkout, brought to its tip first.
export const workspaceRootFor = async (deps: WorkspaceScopeDeps, scope: ReadScope): Promise<string> => {
    const branch = branchScopeOf(scope);
    if (branch !== undefined) {
        return branchViewRoot(deps.branches, branch);
    }
    const { agent } = scope;
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

export const workspaceWriteRootFor = async (deps: WorkspaceScopeDeps, scope: ReadScope, relPath: string): Promise<string> => {
    const branch = branchScopeOf(scope);
    if (branch !== undefined && !(await branchRegion(deps.main, branch.repo)).owns(relPath)) {
        throw new ORPCError("BAD_REQUEST", { message: "This path is outside the selected branch's repository." });
    }
    if (scope.agent !== undefined) {
        const entry = deps.entry(scope.agent);
        if (entry?.placement.kind === "worktree") {
            const path = posix.normalize(relPath).replace(/^\.\//, "");
            const owner = (await discoverRepos(deps.main)).filter((repo) => path === repo || path.startsWith(`${repo}/`)).toSorted((a, b) => b.length - a.length)[0] ?? "root";
            if (!entry.placement.repos.some(({ repo }) => repo === owner)) {
                throw new ORPCError("BAD_REQUEST", { message: "This path is outside the selected session's repositories." });
            }
        }
    }
    return workspaceRootFor(deps, scope);
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
const containedForRead = async (root: string, relPath: string): Promise<string> => {
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
// `shared` reports which tree answered, so the reader is never guessing. A branch never falls back inside its own
// repository, where a file it deleted must read as gone, and always does outside it.
export const scopedTarget = async (
    deps: WorkspaceScopeDeps,
    scope: ReadScope,
    relPath: string,
): Promise<{ readonly target: string; readonly shared: boolean }> => {
    const branch = branchScopeOf(scope);
    if (branch !== undefined) {
        // Asked whatever the path, so a branch no view may show is refused the same way everywhere.
        const view = await branchViewRoot(deps.branches, branch);
        return (await branchRegion(deps.main, branch.repo)).owns(relPath)
            ? { target: await containedForRead(view, relPath), shared: false }
            : { target: await containedForRead(deps.main, relPath), shared: true };
    }
    const root = await workspaceRootFor(deps, scope);
    const scoped = await containedForRead(root, relPath);
    if (root === deps.main || (await present(scoped))) {
        return { target: scoped, shared: root === deps.main };
    }
    return { target: await containedForRead(deps.main, relPath), shared: true };
};
