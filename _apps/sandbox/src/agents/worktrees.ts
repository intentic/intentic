import { access, lstat, mkdir, readdir, rm, rmdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { defaultGit, gitCommitAll, type GitRunner } from "@intentic/scaffold";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import type { Logger } from "pino";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import type { PerfTracker } from "../platform/perf.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import type { WorkspacePaths } from "../workspace/workspace.js";
import { dropAgentRef, dropOrphanParkedRefs, parkAgentRefs, unparkAgentRef } from "./agent-refs.js";
import { overlaysDir, overlaysRoot, type TurnIsolation } from "./isolation.js";

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
    // Is this repo's checkout actually on disk? `archivedAt` cannot answer it: a restored agent keeps the
    // marker clear while its checkout stays retired until the next turn's ensure() re-attaches it. Diff,
    // fileDiff and land all branch on this — the checkout when it is there, the branch refs when it is not.
    readonly attached: (id: string, repo: string) => Promise<boolean>;
    // Create the composition on first use (recorded = []), else repair what the recorded composition names.
    readonly ensure: (id: string, recorded: readonly { repo: string; base: string }[]) => Promise<ConversationWorktree>;
    // Tear down: worktree remove (before the ref goes — git refuses to delete a checked-out branch), then the dir.
    readonly remove: (id: string, recorded: readonly { repo: string; base: string }[]) => Promise<void>;
    // Retire the CHECKOUT and keep the commits — what archiving an agent costs. Everything the worktree still
    // held is committed onto agent/<id> first (land's move, same author), so the branch is a complete record
    // and `ensure` can restore the checkout from it whenever the agent runs again. The branch itself then
    // leaves refs/heads/ for the parked shelf (agents/agent-refs.ts), which nothing above this layer can tell.
    readonly retire: (id: string, recorded: readonly { repo: string; base: string }[], title: string | undefined) => Promise<void>;
    // Boot sweep: delete conversation dirs with no registry entry, `git worktree prune` every repo, park the
    // branches of agents that are off the board, and drop parked refs the registry no longer knows.
    //
    // The id sets are CALLBACKS, re-read at each decision, because this runs DETACHED behind the boot (it is
    // sweep work, and awaiting it held every route for minutes after a crash) — a conversation the user opens
    // while the sweep walks must not be judged by a roster snapshotted before it existed.
    readonly prune: (knownIds: () => readonly string[], archivedIds: () => readonly string[]) => Promise<void>;
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
//
// WHERE ISOLATION IS AVAILABLE, this is done with OVERLAY MOUNTS instead (agents/isolation.ts) and only the
// empty mount point is created here. That is strictly better and not just different: an absolute symlink into
// /work/... would, inside the namespace, point back into the worktree that now occupies /work — a loop. And
// unlike the symlink (or a plain bind), an overlay does not share the WRITE side: pnpm hardlinks a workspace
// package's sources into node_modules, so a write through the mirrored path used to land on the main
// checkout's own tracked file. Reads still come from the main tree; writes stop at the turn's layer.
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
    options: {
        readonly workspace: WorkspacePaths;
        readonly worktreesRoot: string;
        readonly historyRoot: string;
        readonly isolation: TurnIsolation;
        readonly logger: Logger;
        readonly perf: PerfTracker;
    },
    git: GitRunner = defaultGit,
): AgentWorktrees => {
    const { workspace, worktreesRoot, historyRoot, isolation, logger, perf } = options;

    const conversationDir = (id: string): string => join(worktreesRoot, id);
    /* An isolated turn's dependency overlays (isolation.ts) live OUTSIDE the checkout, so reclaiming the
     * checkout does not reclaim them — every teardown path below drops both. They hold only what a turn wrote
     * over the main tree's node_modules (a tsbuildinfo, an install's output), so this is space, never work:
     * nothing an agent is meant to keep is ever written there. */
    const overlaysFor = (id: string): string => overlaysDir(historyRoot, id);
    const worktreeDir = (id: string, repo: string): string => (repo === "root" ? conversationDir(id) : join(conversationDir(id), repo));
    const mainDir = (repo: string): string => (repo === "root" ? workspace.root : join(workspace.root, repo));

    // Per-repo op chains (the history.ts serialize pattern): worktree add/remove and land all touch the repo's
    // shared admin area (<gitdir>/worktrees/) and, for land, the main-tree index. Turns themselves never come
    // through here — per-worktree index/HEAD make concurrent agent work naturally safe.
    const chains = new Map<string, Promise<unknown>>();
    // How many tasks are queued on each repo's chain right now — measurement only, and the single number that
    // separates the two ways this lock makes a user wait (see below).
    const queued = new Map<string, number>();
    /* WAIT AND HOLD ARE MEASURED SEPARATELY, because they are different problems wearing the same symptom.
     *
     * The user clicks Stage; it takes four seconds. Either the stage itself was slow (hold — a huge index, a
     * contended disk), or it sat behind an agent's land checking out the monorepo (wait — the stage was
     * instant and never got to start). Those have nothing in common: one is a git problem, the other is a
     * scheduling one, and a single "the commit took 4s" line cannot tell you which you have. This is the
     * likeliest explanation for "git actions feel slow" and it was completely invisible — a queued task simply
     * had no clock on it until it ran.
     *
     * `depth` is what was already ahead of it in the queue, so a line reads "waited 3.2s behind 2 tasks". */
    const withRepoLock = <T>(repo: string, task: () => Promise<T>): Promise<T> => {
        const chain = chains.get(repo) ?? Promise.resolve();
        const depth = queued.get(repo) ?? 0;
        queued.set(repo, depth + 1);
        const from = process.hrtime.bigint();
        const measured = async (): Promise<T> => {
            perf.record("git.lock.wait", Number(process.hrtime.bigint() - from) / 1e6, { repo, depth });
            try {
                return await perf.track("git.lock.hold", { repo }, task);
            } finally {
                queued.set(repo, (queued.get(repo) ?? 1) - 1);
            }
        };
        const next = chain.then(measured, measured);
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
        /* Past the early return is the RESTORE path, so the branch may be parked — an archived agent the user
         * just sent a message to (registry.begin cleared the marker moments ago), or one this boot's sweep
         * archived for having no checkout. Unparking is a no-op for anything else, and it has to come first:
         * `worktree add` handed a name that resolves only through the shelf checks the commit out DETACHED,
         * and the resumed turn's commits would then land on nothing. One spawn, on the path that already
         * spends several — never on the attached path above, which is every ordinary turn. */
        await unparkAgentRef(mainDir(repo), `agent/${id}`, git).catch((error: unknown) =>
            logger.warn({ err: error, repo }, "agents: branch unpark failed"),
        );
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
        // An isolated turn gets these as bind mounts inside its namespace, so all this has to leave behind is
        // something to mount ONTO. The gitignore check still gates it: an empty dir git would commit is just
        // as unwelcome on the branch as a machine-local symlink.
        const isolated = await isolation.available();
        await Promise.all(
            packages.map(async (pkg) => {
                const rel = linkOf(pkg);
                const target = join(worktree, rel);
                if (!ignored.has(rel) || !(await exists(join(worktree, pkg)))) {
                    return;
                }
                // The mirror's FORM is a property of the container (namespace or not), and worktrees outlive
                // containers on /history — so a checkout can carry the other mode's form, and ensure must
                // converge it. A pre-namespace absolute symlink would, inside the namespace, resolve back into
                // the worktree that now occupies /work — a loop the anchor's mkdir dies on. The other way, an
                // empty mount point left by an isolated run would sit where the symlink belongs and resolve
                // nothing for a namespace-less turn.
                const entry = await lstat(target).catch(() => undefined);
                if (isolated) {
                    if (entry?.isSymbolicLink()) {
                        await rm(target).catch(() => undefined);
                    }
                    await mkdir(target, { recursive: true }).catch((error: unknown) =>
                        logger.warn({ err: error, repo, package: pkg }, "agents: node_modules mount point failed"),
                    );
                    return;
                }
                if (entry?.isDirectory()) {
                    // rmdir refuses a non-empty dir — a real install the agent made stays put.
                    await rmdir(target).catch(() => undefined);
                }
                await symlink(join(main, rel), target, "dir").catch((error: unknown) => {
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
        attached: (id, repo) => exists(join(worktreeDir(id, repo), ".git")),
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
                    // Both spellings: an archived agent being discarded holds its commits on the parked shelf,
                    // and `branch -D` alone would leave them behind with nothing left to reach them by.
                    await dropAgentRef(main, `agent/${id}`, git);
                });
            }
            await rm(conversationDir(id), { recursive: true, force: true });
            await rm(overlaysFor(id), { recursive: true, force: true });
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
                    await git(main, ["worktree", "remove", "--force", worktreeDir(id, repo)]).catch(() =>
                        git(main, ["worktree", "prune"]).catch(() => undefined),
                    );
                    /* The commits stay — they ARE the archive — but the BRANCH does not: it moves to the
                     * parked shelf (agent-refs.ts), so an archive costs the repo no refs/heads/ entry for as
                     * long as nobody opens the conversation again. Inside the repo lock and strictly after
                     * the checkout is gone, because that is the one thing that makes the ref deletable.
                     * Best-effort: an agent whose ref will not park is an agent that archived fine and left a
                     * branch behind, which the next boot's sweep picks up. */
                    await parkAgentRefs(main, new Set([id]), git).catch((error: unknown) =>
                        logger.warn({ err: error, repo, id }, "agents: branch park failed"),
                    );
                });
            await Promise.all(nested.map(({ repo }) => removeOne(repo)));
            if (recorded.some(({ repo }) => repo === "root")) {
                await removeOne("root");
            }
            await rm(conversationDir(id), { recursive: true, force: true });
            // The branch is the archive; the overlays are not part of it — an archived conversation's
            // dependency scratch has no more claim on the disk than a removed one's.
            await rm(overlaysFor(id), { recursive: true, force: true });
        },
        prune: async (knownIds, archivedIds) => {
            for (const name of await readdir(worktreesRoot).catch(() => [])) {
                // Membership is asked of the registry AT the decision — a conversation minted after this sweep
                // started (the sweep runs detached behind boot) must not have its dir swept as an orphan.
                if (!knownIds().includes(name)) {
                    logger.warn({ id: name }, "agents: pruning orphaned worktree dir");
                    await rm(conversationDir(name), { recursive: true, force: true });
                }
            }
            // Swept separately, not alongside the checkouts: an overlay outlives its checkout by design (retire
            // drops the worktree and keeps the branch), so the leftovers here are the ones whose conversation
            // is gone entirely — including any a crash left behind between the two removals above.
            for (const name of await readdir(overlaysRoot(historyRoot)).catch(() => [])) {
                if (!knownIds().includes(name)) {
                    await rm(overlaysFor(name), { recursive: true, force: true });
                }
            }
            for (const repo of await liveRepos()) {
                // Under the repo lock now that the sweep runs concurrently with turns: worktree admin and the
                // parked shelf are exactly what ensure()/remove() touch for the same repo.
                await withRepoLock(repo, async () => {
                    const main = mainDir(repo);
                    await git(main, ["worktree", "prune"]).catch(() => undefined);
                    /* The ref half of the same sweep, and the only pass that can converge an archive taken before
                     * parking existed — or one whose park lost its repo lock to a crash. Both calls are a single
                     * for-each-ref when there is nothing to do, which is every boot after the first.
                     *
                     * Orphan parked refs are dropped against `knownIds`, NOT `archivedIds`: a ref whose entry the
                     * registry has forgotten is holding commits no surface can ever reach again. That is the same
                     * line the conversation-dir sweep above draws, and it stays on the safe side of it — deletion
                     * the user can see (discard, purge) is the only other thing that drops an agent's commits. */
                    const parked = await parkAgentRefs(main, new Set(archivedIds()), git).catch((error: unknown) => {
                        logger.warn({ err: error, repo }, "agents: branch park sweep failed");
                        return [];
                    });
                    const dropped = await dropOrphanParkedRefs(main, new Set(knownIds()), git).catch((error: unknown) => {
                        logger.warn({ err: error, repo }, "agents: parked ref sweep failed");
                        return 0;
                    });
                    if (parked.length > 0 || dropped > 0) {
                        logger.info({ repo, parked: parked.length, dropped }, "agents: swept agent branches off refs/heads");
                    }
                });
            }
        },
        withRepoLock,
    };
};
