import { access, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { defaultGit, gitCommitAll, type GitRunner } from "@intentic/scaffold";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
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

// DEPENDENCY MIRRORING. A worktree is a checkout of TRACKED files, and an installed dependency tree is
// untracked by design (`**/node_modules` is gitignored) — so a fresh worktree holds source that cannot resolve
// a single import. Nothing type-checks, lints or tests, and the post-edit diagnostics gate on a resolvable
// node_modules (agent-diagnostics.ts), so an isolated turn silently gets NO compile feedback at all while the
// readiness notice tells it, every turn, to run an install that would cost minutes and a duplicate tree per
// agent. Mirroring is the cheap answer: one symlink per package, at the same relative path, pointing at the
// main checkout's installed dir. Node and TypeScript both resolve through symlinks by default, so tooling in a
// worktree behaves as it does in /work.
//
// The tradeoff this accepts, deliberately: the tree is SHARED, not copied. A worktree's `pnpm add` writes into
// the main checkout's node_modules (its package.json/lockfile edits stay in the worktree, where they belong),
// and a monorepo's workspace links resolve cross-package imports to /work's sources rather than the worktree's
// edited ones. Both beat the alternative, which is that nothing resolves at all.
const MODULES = "node_modules";

// Deep enough for the layouts that exist (a monorepo's `_apps/<pkg>`, `_libs/<pkg>`), bounded so a pathological
// tree can't stall a turn's first ensure.
const MAX_LINK_DEPTH = 3;

// Every dir under `main` that owns an installed dependency tree, root-relative ("" is `main` itself). Stops at
// a nested repo (`.git`): that repo mirrors into its OWN worktree, and descending would plant its links in the
// parent's checkout instead. Junk dirs are never descended into, so a node_modules is never walked.
const packagesWithModules = async (main: string): Promise<string[]> => {
    const found: string[] = [];
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        if (entries.some((entry) => entry.name === MODULES)) {
            found.push(rel);
        }
        if (depth >= MAX_LINK_DEPTH) {
            return;
        }
        await Promise.all(
            entries
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !IGNORED_DIRS.has(entry.name))
                .map(async (entry) => {
                    const child = join(dir, entry.name);
                    if (await exists(join(child, ".git"))) {
                        return;
                    }
                    await walk(child, rel === "" ? entry.name : `${rel}/${entry.name}`, depth + 1);
                }),
        );
    };
    await walk(main, "", 0);
    return found;
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

    // Which of these link paths git will keep out of a commit — asked of git rather than assumed, because the
    // answer is not the obvious one. `retire` sweeps a worktree with `add -A`, and a gitignore rule written
    // DIRECTORY-ONLY (`node_modules/`, the common form) does not match a symlink: git sees a file, stages it,
    // and a machine-local absolute symlink lands on the agent branch and then in whatever `land` merges. Only a
    // rule that matches files too (`**/node_modules`) makes the link safe to plant. So a repo whose rule is
    // directory-only is left unmirrored on purpose — no tooling, but no poisoned history either.
    //
    // One spawn per repo answers it exactly. check-ignore exits 1 when nothing matches, which is the "link
    // nothing" answer rather than a failure; `-z` is unavailable (it requires --stdin, which GitRunner cannot
    // feed), so this reads line-separated output and any path git chose to quote simply fails to match — the
    // same fail-closed direction as the exit-1 case.
    const ignoredLinks = async (worktree: string, links: readonly string[]): Promise<Set<string>> => {
        if (links.length === 0) {
            return new Set();
        }
        const { stdout } = await git(worktree, ["check-ignore", ...links]).catch(() => ({ stdout: "" }));
        return new Set(stdout.split("\n").filter((path) => path !== ""));
    };

    // Mirror one repo's installed dependency dirs from its main checkout into its worktree. Idempotent — an
    // existing link, and a package the agent's branch doesn't carry, are both left alone — so it re-runs on
    // every ensure and picks up packages whose install landed after the checkout did. Best-effort by design: a
    // link that fails costs that package's tooling, never the turn.
    const linkModules = async (id: string, repo: string): Promise<void> => {
        const main = mainDir(repo);
        const worktree = worktreeDir(id, repo);
        const packages = await packagesWithModules(main);
        const linkOf = (pkg: string): string => (pkg === "" ? MODULES : `${pkg}/${MODULES}`);
        const ignored = await ignoredLinks(worktree, packages.map(linkOf));
        await Promise.all(
            packages.map(async (pkg) => {
                const rel = linkOf(pkg);
                if (!ignored.has(rel) || !(await exists(join(worktree, pkg)))) {
                    return;
                }
                await symlink(join(main, rel), join(worktree, rel), "dir").catch((error: unknown) => {
                    // EEXIST is the steady state, not a failure: the link — or a real install — is already there.
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                        logger.warn({ err: error, repo, package: pkg }, "agents: node_modules link failed");
                    }
                });
            }),
        );
    };

    // Runs once the WHOLE composition is on disk: a nested repo's worktree dir must exist before links can be
    // planted in it. No repo lock — this reads the main checkout and writes only inside this conversation's own
    // worktree, so taking one would serialize the fleet behind a queue it has no reason to join.
    const linkComposition = async (id: string, repos: readonly { readonly repo: string }[]): Promise<void> => {
        await Promise.all(repos.map(({ repo }) => linkModules(id, repo)));
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
                await linkComposition(id, recorded);
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
            await linkComposition(id, repos);
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
                    // It also OVER-reports — dirty content inside a nested repo stages as nothing — which is
                    // why the commit itself is gitCommitAll's call, on the index, and not this probe's.
                    const { stdout } = await git(worktree, ["status", "--porcelain", "-z"]);
                    if (stdout === "") {
                        return;
                    }
                    await gitCommitAll(worktree, `Agent: ${title ?? id}`, AGENT_GIT_AUTHOR, git);
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
