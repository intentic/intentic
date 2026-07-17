import { access, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { listRepos } from "../workspace/extra-repos.js";
import { REPO_ROLES, type WorkspacePaths } from "../workspace/workspace.js";

// A conversation's isolated checkout: one git worktree per workspace repo, mirroring the /work layout —
// <worktreesRoot>/<id>/ is the ROOT repo's worktree and <worktreesRoot>/<id>/repositories/<name>/ each nested
// repo's — so the agent, .claude/ config resolution, and monorepo-relative paths work unmodified. Worktrees
// live on /history (the volume the real git dirs already occupy): they survive container rebuilds, stay
// invisible to the /work tree walk + watcher + iq + history scopes, and their gitdir pointers never straddle
// volumes. The object stores are shared; a worktree costs only its checkout.
//
// The composition is FROZEN at first ensure: repos cloned into /work later don't join an existing
// conversation, and repos the agent clones inside its worktree are outside diff/land (both v2).

export interface ConversationWorktree {
    // The agent's cwd for isolated turns — the root repo's worktree dir.
    readonly cwd: string;
    readonly branch: string;
    // Each repo in the composition with the full sha its branch was created from.
    readonly repos: readonly { repo: string; base: string }[];
}

export interface AgentWorktrees {
    readonly conversationDir: (id: string) => string;
    readonly worktreeDir: (id: string, repo: string) => string;
    readonly mainDir: (repo: string) => string;
    readonly exists: (id: string) => Promise<boolean>;
    // Create the composition on first use (recorded = []), else repair what the recorded composition names.
    readonly ensure: (id: string, recorded: readonly { repo: string; base: string }[]) => Promise<ConversationWorktree>;
    // Tear down: worktree remove (before branch -D — git refuses to delete a checked-out branch), then the dir.
    readonly remove: (id: string, recorded: readonly { repo: string; base: string }[]) => Promise<void>;
    // Boot sweep: delete conversation dirs with no registry entry, then `git worktree prune` every repo.
    readonly prune: (knownIds: readonly string[]) => Promise<void>;
    // Serialize git ops that touch a repo's shared worktree admin area / main index (create/remove/land).
    readonly withRepoLock: <T>(repo: string, task: () => Promise<T>) => Promise<T>;
}

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

export const createAgentWorktrees = (
    options: { readonly workspace: WorkspacePaths; readonly worktreesRoot: string; readonly logger: Logger },
    git: GitRunner = defaultGit,
): AgentWorktrees => {
    const { workspace, worktreesRoot, logger } = options;

    const conversationDir = (id: string): string => join(worktreesRoot, id);
    const worktreeDir = (id: string, repo: string): string =>
        repo === "root" ? conversationDir(id) : join(conversationDir(id), "repositories", repo);
    const mainDir = (repo: string): string => (repo === "root" ? workspace.root : join(workspace.repositories, repo));

    // Per-repo op chains (the history.ts serialize pattern): worktree add/remove and land all touch the repo's
    // shared admin area (<gitdir>/worktrees/) and, for land, the main-tree index. Turns themselves never come
    // through here — per-worktree index/HEAD make concurrent agent work naturally safe.
    const chains = new Map<string, Promise<unknown>>();
    const withRepoLock = <T>(repo: string, task: () => Promise<T>): Promise<T> => {
        const chain = chains.get(repo) ?? Promise.resolve();
        const next = chain.then(task, task);
        chains.set(
            repo,
            next.catch(() => undefined),
        );
        return next;
    };

    const headSha = async (dir: string): Promise<string | undefined> => {
        try {
            return (await git(dir, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
        } catch {
            return undefined;
        }
    };

    const branchExists = async (dir: string, branch: string): Promise<boolean> => {
        try {
            await git(dir, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`]);
            return true;
        } catch {
            return false;
        }
    };

    // The workspace repos a NEW conversation spans: root, the fixed-role repos that exist (listRepos
    // deliberately excludes them), and every extra clone. Unborn-HEAD repos are skipped in createOne — an
    // unborn HEAD has nothing to branch from.
    const liveRepos = async (): Promise<string[]> => {
        const repos = ["root"];
        for (const role of REPO_ROLES) {
            if (await exists(join(workspace.repositories, role, ".git"))) {
                repos.push(role);
            }
        }
        for (const name of await listRepos(workspace.repositories)) {
            repos.push(name);
        }
        return repos;
    };

    const createOne = async (id: string, repo: string): Promise<{ repo: string; base: string } | undefined> => {
        const main = mainDir(repo);
        const base = await headSha(main);
        if (base === undefined) {
            logger.warn({ repo }, "agents: unborn HEAD, repo excluded from worktree composition");
            return undefined;
        }
        const branch = `agent/${id}`;
        const target = worktreeDir(id, repo);
        // A crash between branch creation and checkout leaves the branch without a dir — attach, don't recreate.
        if (await branchExists(main, branch)) {
            await git(main, ["worktree", "add", target, branch]);
        } else {
            await git(main, ["worktree", "add", "-b", branch, target, "HEAD"]);
        }
        return { repo, base };
    };

    const repairOne = async (id: string, repo: string): Promise<void> => {
        const target = worktreeDir(id, repo);
        if (await exists(join(target, ".git"))) {
            return;
        }
        // The worktree analogue of history's healGitPointer: repair rewrites the worktree's .git file and the
        // admin dir's gitdir backlink. A fully deleted worktree dir is re-attached from its surviving branch.
        if (await exists(target)) {
            await git(mainDir(repo), ["worktree", "repair", target]).catch((error: unknown) =>
                logger.warn({ err: error, repo }, "agents: worktree repair failed"),
            );
            return;
        }
        await git(mainDir(repo), ["worktree", "add", target, `agent/${id}`]).catch((error: unknown) =>
            logger.warn({ err: error, repo }, "agents: worktree re-attach failed"),
        );
    };

    return {
        conversationDir,
        worktreeDir,
        mainDir,
        exists: (id) => exists(conversationDir(id)),
        ensure: async (id, recorded) => {
            const branch = `agent/${id}`;
            if (recorded.length > 0) {
                for (const { repo } of recorded) {
                    await withRepoLock(repo, () => repairOne(id, repo));
                }
                return { cwd: conversationDir(id), branch, repos: recorded };
            }
            const repos: { repo: string; base: string }[] = [];
            // Root first: its checkout creates the conversation dir the nested worktrees mount into (the root
            // repo excludes /repositories/, so the mounts never collide with its own tracked files).
            for (const repo of await liveRepos()) {
                const created = await withRepoLock(repo, () => createOne(id, repo));
                if (created !== undefined) {
                    repos.push(created);
                }
            }
            return { cwd: conversationDir(id), branch, repos };
        },
        remove: async (id, recorded) => {
            for (const { repo } of recorded) {
                await withRepoLock(repo, async () => {
                    const main = mainDir(repo);
                    await git(main, ["worktree", "remove", "--force", worktreeDir(id, repo)]).catch(() =>
                        // Dir already gone — drop the stale admin entry instead.
                        git(main, ["worktree", "prune"]).catch(() => undefined),
                    );
                    await git(main, ["branch", "-D", `agent/${id}`]).catch(() => undefined);
                });
            }
            await rm(conversationDir(id), { recursive: true, force: true });
        },
        prune: async (knownIds) => {
            const known = new Set(knownIds);
            for (const name of await readdir(worktreesRoot).catch(() => [])) {
                if (!known.has(name)) {
                    logger.warn({ id: name }, "agents: pruning orphaned worktree dir");
                    await rm(conversationDir(name), { recursive: true, force: true });
                }
            }
            for (const repo of await liveRepos()) {
                await git(mainDir(repo), ["worktree", "prune"]).catch(() => undefined);
            }
        },
        withRepoLock,
    };
};
