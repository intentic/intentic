import { access } from "node:fs/promises";
import { ConversationIdSchema } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import { isIsolated, type PersistedAgent } from "../agents/agents-store.js";
import { isControlPlanePath, realWithin, resolveWithin } from "./workspace-files.js";

/* WHOSE COPY OF THE WORKSPACE A READ MEANS — resolved once, here, for every route that serves a file.
 *
 * The daemon has always had more than one workspace and only ever admitted to one. There is the shared /work
 * tree, and there is a private checkout per isolated conversation; a workspace read named a PATH and nothing
 * else, so it could only answer from /work. That is why a link to a file an agent had just created opened a
 * not-found page — and why a link to a file it had EDITED opened something worse: the shared version of the
 * same path, different text, with nothing on screen to say the reader was looking at a different file than
 * the one the agent had described.
 *
 * So the conversation rides the request (WorkspaceScopeSchema) and lands here. Everything downstream — the
 * escape guard, the control-plane denylist, the ignore rules, the tree walk — already takes a root as an
 * argument, so scoping is a matter of choosing that root rather than of teaching each of them a second mode.
 *
 * READS ONLY, BY CONSTRUCTION. No write route accepts a scope: the schemas do not carry the field, so there is
 * no runtime refusal to get wrong and no screen that can talk the daemon into writing into a checkout its
 * agent may be mid-turn on. Two writers on one worktree file is exactly the silent-loss failure that
 * agents/worktree-redirect.ts exists to prevent, and it is not worth reintroducing through a file API.
 */

export interface WorkspaceScopeDeps {
    // The shared /work tree — the answer when no conversation is named, and the fallback below.
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

/* Resolve a root-relative path to an absolute one inside `root`, applying the read routes' guards: a
 * `../`/absolute path that climbs out is BAD_REQUEST, and the daemon's own private state is not reachable
 * through the generic file API — read, write, move or delete. NOT_FOUND rather than FORBIDDEN for
 * the second: the file API simply has nothing there, and a distinct code would confirm what it holds.
 *
 * The escape guard is asked TWICE, of two different things: once of the path as a string (resolveWithin), and
 * once of the disk, which is the only one of the two that can see a symlink pointing out of the workspace
 * (realWithin). Both answer BAD_REQUEST — from the caller's side they are one rule, "that path is not in this
 * workspace", and which of the two noticed is not the caller's business.
 */
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

/* The root a scope names.
 *
 * A conversation that is NOT isolated resolves back to the shared tree rather than failing: /work genuinely is
 * its tree, and a surface linking to a file should not have to know which mode a conversation runs in to
 * produce a working link.
 *
 * A retired checkout is the one hard stop. Archiving an agent commits what its worktree held onto agent/<id>
 * and drops the checkout (agents/worktrees.ts), so the work survives as branch state with no directory to read
 * — a distinct condition from "no such file", and the browser branches on the status to explain it rather than
 * showing a not-found page for a file that demonstrably exists.
 */
export const workspaceRootFor = async (deps: WorkspaceScopeDeps, agent: string | undefined): Promise<string> => {
    if (agent === undefined) {
        return deps.main;
    }
    // The oRPC routes validate the id through the contract, but the raw/media byte routes read it off a query
    // string — and it becomes a path segment below. The guard lives here so it cannot be the one route that
    // forgot it; a registry hit alone would make containment depend on how the registry was populated.
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
            message: "this agent's files were cleaned up when it was archived — its work is kept on its branch, in its changes",
        });
    }
    return dir;
};

/* WHERE A SCOPED READ ACTUALLY LANDS — the conversation's checkout when the path is there, the shared tree
 * when it is not.
 *
 * The fallback is not a hedge, it is the difference between a usable view and a maze. A conversation's
 * checkout mirrors the /work layout but is not a superset of it: the dirs an isolated turn reaches through the
 * namespace (node_modules, the reference shelf, the shared .intentic state) are bare mount points from outside
 * it, and anything under /work that no repo tracks was never in the checkout at all. Refusing those would mean
 * a reader who followed one link into an agent's copy then found half the workspace missing, with no
 * explanation that would make sense.
 *
 * `shared` travels back with the answer so the reader is never guessing which of the two they got.
 */
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
