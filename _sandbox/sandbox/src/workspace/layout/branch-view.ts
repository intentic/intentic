import { posix } from "node:path";
import type { RepoBranch } from "@intentic/sandbox-contract/schemas/shared";
import { ORPCError } from "@orpc/server";
import type { BranchCheckouts } from "../../conversations/worktrees/branches/branch-checkouts.js";
import { discoverRepos } from "./repo-discovery.js";

// A BRANCH, LOOKED AT WITHOUT LEAVING THE MAIN LINE (2026-10-29). The shared checkout stays on its main line
// (git/main-line-lock.ts), so a person who picks another branch of one repository in the Workspace reads it from the
// checkout the daemon keeps of it (conversations/worktrees/branches/branch-checkouts.ts), laid out like /work. What belongs to
// that repository is read from the branch alone: a file the branch deleted is not there, however much the shared tree
// still holds it. Everything else (the other repositories, the workspace's own files around a nested one, a repository
// nested deeper inside the one viewed) is the shared tree's, so the rest of the workspace stays in view. Read-only, as
// every scope is: no write route takes one.

/** Which copy a read means, as every scoped route's input carries it (WorkspaceScopeSchema). */
export interface ReadScope {
    readonly agent?: string | undefined;
    readonly branch?: string | undefined;
    readonly repo?: string | undefined;
}

export type BranchViews = Pick<BranchCheckouts, "refresh" | "viewRoot" | "checkoutDir">;

/**
 * The branch a scope names, checked; undefined for a conversation's copy or the shared tree. `repo` alone is refused
 * rather than ignored: it only ever says which repository a branch is of, and a client that lost the branch would
 * otherwise be shown the main line as if it were the branch it picked.
 */
export const branchScopeOf = (scope: ReadScope): RepoBranch | undefined => {
    if (scope.branch === undefined) {
        if (scope.repo !== undefined) {
            throw new ORPCError("BAD_REQUEST", { message: "`repo` says which repository a branch is of: name the branch too" });
        }
        return undefined;
    }
    if (scope.agent !== undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "a read is of one copy, an agent's or a branch's, not both" });
    }
    return { repo: scope.repo ?? "root", branch: scope.branch };
};

// How long the shared tree's list of nested repositories is reused: asked on every read of a branch view, and a
// repository appearing is a clone, rare and never mid-read.
const REPOS_TTL_MS = 10_000;
const reposSeen = new Map<string, { readonly at: number; readonly repos: Promise<string[]> }>();

const nestedReposOf = (main: string): Promise<string[]> => {
    const hit = reposSeen.get(main);
    if (hit !== undefined && Date.now() - hit.at < REPOS_TTL_MS) {
        return hit.repos;
    }
    const repos = discoverRepos(main);
    reposSeen.set(main, { at: Date.now(), repos });
    // A walk that failed is not remembered: the next read asks again.
    void repos.catch(() => reposSeen.delete(main));
    return repos;
};

// A workspace path as one spelling: no leading `./` or `/`, no trailing `/`, the root as "". Escapes are left to the
// resolver, which refuses them whichever tree is asked.
const normal = (relPath: string): string => {
    const cleaned = posix.normalize(`/${relPath}`).replace(/^\/+|\/+$/g, "");
    return cleaned === "." ? "" : cleaned;
};

const atOrUnder = (path: string, dir: string): boolean => dir === "" || path === dir || path.startsWith(`${dir}/`);
const strictlyAbove = (path: string, dir: string): boolean => dir !== path && (path === "" || dir.startsWith(`${path}/`));

/** Which paths of the workspace a branch view reads from the branch, and which from the shared tree. */
export interface BranchRegion {
    // The viewed repository's folder: "" for the workspace itself.
    readonly dir: string;
    // Repositories nested inside it, which the shared tree answers for.
    readonly deeper: readonly string[];
    // The branch answers for this path, and only the branch.
    readonly owns: (relPath: string) => boolean;
    // A folder both answer under: one leading to the viewed repository, or to a repository nested inside it.
    readonly mixed: (relPath: string) => boolean;
}

export const branchRegion = async (main: string, repo: string): Promise<BranchRegion> => {
    const dir = repo === "root" ? "" : normal(repo);
    const deeper = (await nestedReposOf(main)).filter((nested) => nested !== dir && atOrUnder(nested, dir));
    const owns = (relPath: string): boolean => {
        const path = normal(relPath);
        return atOrUnder(path, dir) && !deeper.some((nested) => atOrUnder(path, nested));
    };
    const mixed = (relPath: string): boolean => {
        const path = normal(relPath);
        return strictlyAbove(path, dir) || (atOrUnder(path, dir) && deeper.some((nested) => strictlyAbove(path, nested)));
    };
    return { dir, deeper, owns, mixed };
};

/** The branch's checkout brought to its tip, and the workspace-shaped folder paths resolve against in it. */
export const branchViewRoot = async (views: BranchViews, { repo, branch }: RepoBranch): Promise<string> => {
    await views.refresh(repo, branch);
    return views.viewRoot(repo, branch);
};
