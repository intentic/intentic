import { access } from "node:fs/promises";
import { ConversationIdSchema } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import { isIsolated, type PersistedAgent } from "../../agents/registry/agents-store.js";
import { isControlPlanePath, realWithin, resolveWithin } from "../files/workspace-files-paths.js";

// Resolves whose copy of the workspace a read means, for every file-serving route; downstream just takes the chosen
// root.
// Reads only: no write route's schema carries a scope field, so the file API can't write into a checkout mid-turn.

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
    if (!isIsolated(entry)) {
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

// Falls back to the shared tree when the path isn't in the checkout: it mirrors /work's layout but isn't a superset.
// `shared` reports which tree answered, so the reader is never guessing.
export const scopedTarget = async (
    deps: WorkspaceScopeDeps,
    agent: string | undefined,
    relPath: string,
): Promise<{ readonly target: string; readonly shared: boolean }> => {
    const root = await workspaceRootFor(deps, agent);
    const scoped = await containedIn(root, relPath);
    if (root === deps.main || (await present(scoped))) {
        return { target: scoped, shared: root === deps.main };
    }
    return { target: await containedIn(deps.main, relPath), shared: true };
};
