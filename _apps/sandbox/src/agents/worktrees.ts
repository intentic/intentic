import { access, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import type { WorkspacePaths } from "../workspace/workspace.js";

// A conversation's isolated checkout: one git worktree per workspace repo, mirroring the /work layout —
// <worktreesRoot>/<id>/ is the ROOT repo's worktree and <worktreesRoot>/<id>/<repo>/ each nested
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
    // Retire the CHECKOUT and keep the branch — what archiving an agent costs. Everything the worktree still
    // held is committed onto agent/<id> first (land's move, same author), so the branch is a complete record
    // and `ensure` can restore the checkout from it whenever the agent runs again.
    readonly retire: (id: string, recorded: readonly { repo: string; base: string }[], title: string | undefined) => Promise<void>;
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
    const worktreeDir = (id: string, repo: string): string => (repo === "root" ? conversationDir(id) : join(conversationDir(id), repo));
    const mainDir = (repo: string): string => (repo === "root" ? workspace.root : join(workspace.root, repo));

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

    // The workspace repos a NEW conversation spans: root plus every discovered repo. Unborn-HEAD repos are
    // skipped in createOne — an unborn HEAD has nothing to branch from.
    const liveRepos = async (): Promise<string[]> => ["root", ...(await discoverRepos(workspace.root))];

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
            // repo excludes every repo dir — syncRootExcludes — so the mounts never collide with its own
            // tracked files).
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
        retire: async (id, recorded, title) => {
            // Two passes on purpose. EVERY repo is committed before ANY checkout goes, so a failure partway
            // through leaves worktrees standing rather than a branch that is missing the work its checkout held.
            //
            // PASS 1 takes NO repo lock, and that is the difference between archiving one agent and archiving
            // ten: `withRepoLock` is a per-repo chain shared by every agent, so holding it here would serialize
            // the whole fleet's preserve work behind one queue. Nothing in this pass needs it — the status read,
            // the index write and the commit all happen inside THIS agent's own worktree (its own index, its own
            // HEAD), and the only shared things it touches are the object store (content-addressed) and its own
            // refs/heads/agent/<id> (git's per-ref lockfile). The admin area `withRepoLock` exists to protect is
            // touched only by pass 2.
            await Promise.all(
                recorded.map(async ({ repo }) => {
                    const worktree = worktreeDir(id, repo);
                    if (!(await exists(join(worktree, ".git")))) {
                        return; // Never created, or already retired — nothing to preserve.
                    }
                    // ONE spawn to answer "is there anything to keep", which is the answer in the common case:
                    // a cleanly-landed agent's worktree is already clean, because land committed its remainder.
                    // (The full changedFiles read this replaced cost five to seven spawns to say the same thing,
                    // per repo, per agent — the single biggest chunk of an archive's wall clock.) Porcelain
                    // covers staged, unstaged AND untracked, which is exactly what `add -A` below would sweep.
                    const { stdout } = await git(worktree, ["status", "--porcelain", "-z"]);
                    if (stdout === "") {
                        return;
                    }
                    await git(worktree, ["add", "-A"]);
                    await git(worktree, [
                        "-c",
                        `user.name=${AGENT_GIT_AUTHOR.name}`,
                        "-c",
                        `user.email=${AGENT_GIT_AUTHOR.email}`,
                        "commit",
                        "-q",
                        "-m",
                        `Agent: ${title ?? id}`,
                    ]);
                }),
            );
            // PASS 2 does need the lock (worktree admin area), but only per repo — so the nested repos run
            // concurrently with each other. ROOT GOES LAST: its worktree dir is the parent the nested checkouts
            // mount into, so removing it first deletes them out from under their own `worktree remove`, which
            // then fails into a `prune` fallback — two wasted spawns per nested repo, every time.
            const nested = recorded.filter(({ repo }) => repo !== "root");
            const removeOne = (repo: string): Promise<void> =>
                withRepoLock(repo, async () => {
                    const main = mainDir(repo);
                    // No `branch -D` — the branch IS the archive. Only the checkout is reclaimed.
                    await git(main, ["worktree", "remove", "--force", worktreeDir(id, repo)]).catch(() =>
                        git(main, ["worktree", "prune"]).catch(() => undefined),
                    );
                });
            await Promise.all(nested.map(({ repo }) => removeOne(repo)));
            if (recorded.some(({ repo }) => repo === "root")) {
                await removeOne("root");
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
