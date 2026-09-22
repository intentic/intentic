import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathExists } from "../../path-exists.js";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { gitDirOf } from "../../git/git-dir.js";
import { commitWorktreeRemainder } from "../../git/remote/root-repo.js";
import type { PerfTracker } from "../../platform/resources/perf.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import type { WorkspacePaths } from "../../workspace/workspace.js";
import { dropAgentRef, dropOrphanParkedRefs, parkAgentRefs, unparkAgentRef } from "../land/agent-refs.js";
import { claudeStoreOf, sessionsDir, sessionsRoot, type StoreOwner } from "../../sessions/session-store.js";
import { mirroredDirs, overlaysDir, overlaysRoot, type TurnIsolation } from "./isolation.js";
import { coneFor, fencedComposition } from "./worktree-cone.js";
import type { Fence } from "@intentic/sandbox-contract";

// A conversation's isolated checkout: one git worktree per workspace repo, root at <worktreesRoot>/<id>/, nested repos
// at <id>/<repo>/, mirroring the /work layout.
// Worktrees live on /history: they survive container rebuilds and stay outside the /work tree walk, watcher, iq and
// history scopes; object stores stay shared.
// Repos an agent clones inside its own worktree are outside diff and land.

export interface ConversationWorktree {
    // The agent's cwd for isolated turns: the root repo's worktree dir.
    readonly cwd: string;
    // The conversation's OWN ref, always `agent/<id>`: its identity, what a runner syncs and what land reads. Not a
    // claim about what any checkout currently stands on — `elsewhere` is that.
    readonly branch: string;
    // Each repo's full sha on the main line, updated by the pre-turn rebase (agents/sync.ts); not the start.
    readonly repos: readonly { repo: string; base: string }[];
    // Whether this checkout was cut to a fence; what the turn's namespace must not hand back (isolation.ts).
    readonly fenced: boolean;
    // Repos whose checkout is standing somewhere other than `branch`, with what it stands on (absent = detached HEAD).
    // Reported, never corrected: a turn that cut a branch of its own is doing real work, and yanking its checkout back
    // would take that work's context away. Empty is the ordinary case.
    readonly elsewhere: readonly { readonly repo: string; readonly branch?: string }[];
}

export interface AgentWorktrees {
    readonly conversationDir: (id: string) => string;
    readonly worktreeDir: (id: string, repo: string) => string;
    readonly mainDir: (repo: string) => string;
    // The conversation's runtime session store, wherever the fence it was born with puts it (sessions/session-store.ts).
    readonly sessionStore: (entry: StoreOwner | undefined) => string;
    readonly exists: (id: string) => Promise<boolean>;
    // Is this repo's checkout on disk AND still on `agent/<id>`; `archivedAt` cannot answer it since a restored agent's
    // checkout stays retired until the next ensure().
    // Diff, fileDiff and land branch on this: the checkout when present, branch refs when not. A checkout the turn moved
    // to a branch of its own counts as retired, or those three would read someone else's tip as this conversation's
    // work — which is how a land came to apply nothing while the review still listed files.
    readonly attached: (id: string, repo: string) => Promise<boolean>;
    // Which of a conversation's checkouts are standing somewhere other than `agent/<id>`, and on what. One reading for
    // every caller that reports drift, so the invariant and the review cannot describe the same tree differently.
    readonly elsewhere: (id: string, repos: readonly { readonly repo: string }[]) => Promise<ConversationWorktree["elsewhere"]>;
    // The current full HEAD of every repository a new conversation would span.
    // A workflow captures this once and hands it to every candidate so a fan-out sees one snapshot, not several moving
    // workspaces.
    readonly snapshot: () => Promise<ConversationWorktree["repos"]>;
    // Creates the composition on first use (recorded = []), optionally pinned to a caller-owned snapshot.
    // Otherwise repairs the recorded composition and brings it to `selection` when one is given.
    readonly ensure: (
        id: string,
        recorded: readonly { repo: string; base: string }[],
        base?: readonly { repo: string; base: string }[],
        // Whether the turn enters a namespace (mirror form follows); absent means the container's own answer.
        namespaced?: boolean,
        // Which repos the conversation carries (persona card's `context`); absent means every live repo.
        // - a named repo not yet recorded joins (fresh checkout, or its parked branch back)
        // - a recorded repo not named here leaves (remainder committed onto agent/<id>, branch parked)
        // - a name with no live repository is ignored
        selection?: readonly string[],
        // The conversation's own fence, as workspace-relative folders; absent means the whole tree.
        // Narrows the composition to the repositories it reaches, and cuts each of those to a sparse checkout, so the
        // fence is enforced by ABSENCE rather than by a tool hook a shell can compute its way around.
        fence?: Fence,
    ) => Promise<ConversationWorktree>;
    // Tear down: worktree remove before the ref (git refuses to delete a checked-out branch), then the dir.
    readonly remove: (id: string, recorded: readonly { repo: string; base: string }[]) => Promise<void>;
    // Retires the checkout, keeps the commits: everything held is committed onto agent/<id> first (same author as
    // land).
    // The branch then leaves refs/heads/ for the parked shelf (agents/agent-refs.ts); ensure() restores from it later.
    readonly retire: (id: string, recorded: readonly { repo: string; base: string }[], title: string | undefined) => Promise<void>;
    // Gets a deleted repo's checkout out of a conversation (disk half of dropping it, agents/vanished-repos.ts); not a
    // worktree remove since no repo remains to run one in.
    // Left alone, its untracked-by-exclude tree would be swept onto the agent's branch by the next `add -A`; moved to
    // trash rather than deleted, like the git dir that went with it.
    readonly reapRepoCheckout: (id: string, repo: string) => Promise<void>;
    // Boot sweep: deletes conversation dirs with no registry entry, prunes worktree admin, parks off-board branches,
    // drops orphan parked refs.
    // The id sets are callbacks re-read at each decision since this runs detached behind boot, not off a roster
    // snapshot.
    readonly prune: (knownIds: () => readonly string[], archivedIds: () => readonly string[]) => Promise<void>;
    // Serialize git ops that touch a repo's shared worktree admin area / main index (create/remove/land).
    readonly withRepoLock: <T>(repo: string, task: () => Promise<T>) => Promise<T>;
    // Whether that chain is held or queued on right now; a read that would otherwise wait behind a land asks this.
    readonly repoBusy: (repo: string) => boolean;
}

// Root first or root last, then everything else concurrently: root's checkout creates the dir nested worktrees mount
// into, so it can't run beside them.
// `direction` picks the end: build needs the parent first, teardown needs it last or nested `worktree remove`s find
// their dir already gone.
const eachRepo = async (
    repos: readonly { readonly repo: string }[],
    direction: "root-first" | "root-last",
    task: (repo: string) => Promise<void>,
): Promise<void> => {
    const together = (wanted: boolean): Promise<unknown> =>
        Promise.all(repos.filter(({ repo }) => (repo === "root") === wanted).map(({ repo }) => task(repo)));
    if (direction === "root-first") {
        await together(true);
    }
    await together(false);
    if (direction === "root-last") {
        await together(true);
    }
};

// A worktree checks out only tracked files; node_modules and build output are mirrored in via symlink (one per dir,
// same relative path) so imports resolve like /work's.
// Where overlay mounts are available (isolation.ts) this only creates the empty mount point instead: a mirrored symlink
// would loop back into /work and share writes; an overlay keeps writes on the turn's layer.

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
    // Dependency overlays (isolation.ts) live outside the checkout; every teardown path below must drop both.
    // They hold only what a turn wrote over the main tree's node_modules: disk space, never work worth keeping.
    const overlaysFor = (id: string): string => overlaysDir(historyRoot, id);
    const worktreeDir = (id: string, repo: string): string => (repo === "root" ? conversationDir(id) : join(conversationDir(id), repo));
    const mainDir = (repo: string): string => (repo === "root" ? workspace.root : join(workspace.root, repo));

    // Is there still a repository behind this checkout: every git command against one without it fails permanently
    // (`fatal: not a git repository`); asked before retire tries to preserve anything. A worktree's admin dir lives in
    // `<main>/.git/worktrees/<name>`, which a deleted, re-cloned or renamed repo takes with it.
    const repoBehind = async (worktree: string): Promise<boolean> => (await gitDirOf(worktree)) !== undefined;

    // Which branch an admin area's HEAD names, undefined for a detached HEAD, which is not a branch. Split from the
    // lookup above so a caller that already has the gitDir (and so already knows a checkout stands here at all) can
    // tell a detached HEAD from no checkout, which the branch alone cannot say.
    const headBranchIn = async (gitDir: string): Promise<string | undefined> =>
        (await readFile(join(gitDir, "HEAD"), "utf8").catch(() => ``)).match(/^ref:\s*refs\/heads\/(\S+)$/m)?.[1];

    // Which branch a checkout is on, read off the files rather than through git: `attached` asks this once per repo on
    // every diff read, and a subprocess per ask is a cost the review would pay on every refresh. Undefined for a
    // detached HEAD, which is not a branch.
    const checkedOutBranch = async (worktree: string): Promise<string | undefined> => {
        const gitDir = await gitDirOf(worktree);
        return gitDir === undefined ? undefined : headBranchIn(gitDir);
    };

    // Per-repo op chains: worktree add/remove and land touch the repo's admin area and, for land, the main index.
    const chains = new Map<string, Promise<unknown>>();
    // Tasks queued on each repo's chain right now; measurement only.
    const queued = new Map<string, number>();
    // Wait and hold are measured separately: a slow git op (hold) and one queued behind another repo's lock (wait) are
    // different problems.
    // `depth` is what was already ahead of it in the queue, so a line reads "waited 3.2s behind 2 tasks".
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

    // Which of a composition's checkouts are standing off `agent/<id>`, in composition order. Two small file reads per
    // repo, so a turn's opening pays nothing measurable for an answer it would otherwise never get.
    const elsewhereIn = async (id: string, repos: readonly { repo: string }[]): Promise<ConversationWorktree["elsewhere"]> => {
        const own = `agent/${id}`;
        const standing = await Promise.all(
            repos.map(async ({ repo }) => {
                const gitDir = await gitDirOf(worktreeDir(id, repo));
                // No checkout at all is retired, not strayed: nothing stands anywhere for this to report.
                if (gitDir === undefined) {
                    return undefined;
                }
                const branch = await headBranchIn(gitDir);
                return branch === own ? undefined : { repo, ...(branch === undefined ? {} : { branch }) };
            }),
        );
        return standing.filter((entry) => entry !== undefined);
    };

    // The repos a new conversation spans: root plus discovered repos; unborn HEAD is skipped in createOne.
    const liveRepos = async (): Promise<string[]> => ["root", ...(await discoverRepos(workspace.root))];

    const createOne = async (id: string, repo: string, pinned?: string): Promise<{ repo: string; base: string } | undefined> => {
        const main = mainDir(repo);
        const base = pinned ?? (await headSha(main));
        if (base === undefined) {
            logger.warn({ repo }, "agents: unborn HEAD, repo excluded from worktree composition");
            return undefined;
        }
        const branch = `agent/${id}`;
        const target = worktreeDir(id, repo);
        // A crash between branch creation and checkout leaves the branch without a dir; attach it, don't recreate.
        if (await branchExists(main, branch)) {
            await git(main, ["worktree", "add", target, branch]);
        } else {
            await git(main, ["worktree", "add", "-b", branch, target, base]);
        }
        // The state dir needs nothing here: tracked slice checks out normally; untracked binds via the namespace.
        return { repo, base };
    };

    const repairOne = async (id: string, repo: string): Promise<void> => {
        const target = worktreeDir(id, repo);
        if (await pathExists(join(target, ".git"))) {
            return;
        }
        // Unparking comes first: `worktree add` on a parked name would check it out detached, losing resumed commits.
        await unparkAgentRef(mainDir(repo), `agent/${id}`, git).catch((error: unknown) =>
            logger.warn({ err: error, repo }, "agents: branch unpark failed"),
        );
        // Analogous to history's healGitPointer; a deleted worktree dir instead re-attaches from its surviving branch.
        if (await pathExists(target)) {
            await git(mainDir(repo), ["worktree", "repair", target]).catch((error: unknown) =>
                logger.warn({ err: error, repo }, "agents: worktree repair failed"),
            );
        } else {
            await git(mainDir(repo), ["worktree", "add", target, `agent/${id}`]).catch((error: unknown) =>
                logger.warn({ err: error, repo }, "agents: worktree re-attach failed"),
            );
        }
    };

    // Which of these mirror paths git will actually ignore. A mirror is a SYMLINK, and a directory-only gitignore rule
    // (`node_modules/`) matches a directory but never a symlink, so the answer differs by what stands there when asked;
    // every caller below asks about links that already exist. check-ignore exits 1 for "none of them", not failure.
    const ignoredLinks = async (worktree: string, links: readonly string[]): Promise<Set<string>> => {
        if (links.length === 0) {
            return new Set();
        }
        const { stdout } = await git(worktree, ["check-ignore", ...links]).catch(() => ({ stdout: "" }));
        return new Set(stdout.split("\n").filter((path) => path !== ""));
    };

    // Git's own exclude file for a repo: never committed, never pushed, and shared by every worktree of it (git reads
    // it from the common dir, not the per-worktree one). Anchored, file-matching lines here cover the symlink form that
    // a repo's own `node_modules/` cannot, so no `git add -A` — the pre-turn anchor's or an agent's own — can commit a
    // mirror onto the branch and hand the land a symlink it can never apply over the user's real directory.
    const MIRROR_EXCLUDE_NOTE = "# intentic: dependency and build dirs mirrored into agent worktrees.";

    const excludeFileOf = async (main: string): Promise<string | undefined> => {
        const { stdout } = await git(main, ["rev-parse", "--git-common-dir"]).catch(() => ({ stdout: "" }));
        const common = stdout.trim();
        return common === "" ? undefined : join(resolve(main, common), "info", "exclude");
    };

    const excludeMirrors = async (main: string, mirrors: readonly string[]): Promise<void> => {
        if (mirrors.length === 0) {
            return;
        }
        const path = await excludeFileOf(main);
        if (path === undefined) {
            return;
        }
        const current = await readFile(path, "utf8").catch(() => "");
        const written = new Set(current.split("\n").map((line) => line.trim()));
        const missing = mirrors.map((rel) => `/${rel}`).filter((pattern) => !written.has(pattern));
        if (missing.length === 0) {
            return;
        }
        const kept = current.replace(/\n+$/, "");
        const body = [...(kept === "" ? [] : [kept]), MIRROR_EXCLUDE_NOTE, ...missing, ""].join("\n");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, body).catch((error: unknown) => logger.warn({ err: error, main }, "agents: mirror exclude write failed"));
    };

    // Mirrors one repo's untracked dependency/build-output dirs from main checkout into the worktree; idempotent, safe
    // to re-run on every ensure.
    // Best-effort: a failed link costs that package's tooling, never the turn.
    const linkMirrors = async (id: string, repo: string, namespaced?: boolean): Promise<void> => {
        const main = mainDir(repo);
        const worktree = worktreeDir(id, repo);
        const mirrors = await mirroredDirs(main, worktree, { intoNestedRepos: false });
        // A namespaced turn only needs the mount point (overlay mounts fill it); a cwd-only turn (Codex, ACP, Pi) needs
        // the actual symlink.
        const isolated = (namespaced ?? true) && (await isolation.available());
        await Promise.all(
            mirrors.map(async (rel) => {
                const target = join(worktree, rel);
                // Skip when the package's dir isn't in this branch's checkout.
                if (!(await pathExists(join(worktree, dirname(rel))))) {
                    return;
                }
                // The mirror's form follows the container, not the checkout: worktrees outlive containers, so a
                // checkout can carry the other mode's form and must converge here.
                // A stale symlink would loop back into the worktree from inside a namespace; a stale mount point
                // resolves nothing outside one.
                const entry = await lstat(target).catch(() => undefined);
                if (isolated) {
                    if (entry?.isSymbolicLink()) {
                        await rm(target).catch(() => undefined);
                    }
                    await mkdir(target, { recursive: true }).catch((error: unknown) =>
                        logger.warn({ err: error, repo, mirror: rel }, "agents: mirror mount point failed"),
                    );
                    return;
                }
                if (entry?.isDirectory()) {
                    // rmdir refuses a non-empty dir, so a real install the agent made stays put.
                    await rmdir(target).catch(() => undefined);
                }
                // "junction" on Windows: a dir symlink needs a privilege accounts lack; a junction resolves it
                // unprivileged.
                await symlink(join(main, rel), target, process.platform === "win32" ? "junction" : "dir").catch((error: unknown) => {
                    // EEXIST is the steady state, not a failure: the link, or a real install, is already there.
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                        logger.warn({ err: error, repo, mirror: rel }, "agents: mirror link failed");
                    }
                });
            }),
        );
        if (!isolated) {
            await secureLinks(main, worktree, mirrors, repo);
        }
    };

    // Every link git would stage, asked of the links as they now stand rather than of whatever preceded them: the
    // question only has an answer once the symlink exists. Excluding them locally settles it for any repo whose rule is
    // merely directory-only; a repo that actively un-ignores the path (a tracked `!` rule outranks info/exclude) keeps
    // no link at all, since a committed mirror blocks every land afterwards with a conflict neither side can clear.
    // Only symlinks are dropped: a real install the agent made is a directory and stays.
    const secureLinks = async (main: string, worktree: string, mirrors: readonly string[], repo: string): Promise<void> => {
        const already = await ignoredLinks(worktree, mirrors);
        const stageable = mirrors.filter((rel) => !already.has(rel));
        if (stageable.length === 0) {
            return;
        }
        await excludeMirrors(main, stageable);
        const covered = await ignoredLinks(worktree, stageable);
        await Promise.all(
            stageable
                .filter((rel) => !covered.has(rel))
                .map(async (rel) => {
                    const target = join(worktree, rel);
                    if ((await lstat(target).catch(() => undefined))?.isSymbolicLink() !== true) {
                        return;
                    }
                    logger.warn({ repo, mirror: rel }, "agents: mirror left unlinked, this repo un-ignores it");
                    await rm(target).catch(() => undefined);
                }),
        );
    };

    // Runs once the whole composition is on disk: a nested repo's worktree dir must exist before links land in it.
    // No repo lock: this only touches this conversation's own worktree, so locking would needlessly serialize the
    // fleet.
    const linkComposition = async (id: string, repos: readonly { readonly repo: string }[], namespaced?: boolean): Promise<void> => {
        await Promise.all(repos.map(({ repo }) => linkMirrors(id, repo, namespaced)));
    };

    // Cuts one repo's checkout to the folders the conversation may touch. Cone mode, which git keeps per worktree, so
    // this never reaches the shared tree or another conversation's.
    // Honest about its own edge: cone mode always keeps a repository's ROOT-level files, so a fenced checkout still
    // holds the README and package.json beside the folders it was given. Everything in a directory it was not given
    // is genuinely absent.
    // Not undone anywhere: a conversation's fence is latched at its first turn, so one born unfenced never becomes
    // sparse and one born fenced stays that way. Re-applied every ensure, which is what makes an edited area move an
    // existing conversation's checkout.
    const sparsen = async (id: string, repo: string, fence: Fence): Promise<void> => {
        const cone = coneFor(fence, repo);
        if (cone === undefined) {
            return;
        }
        const worktree = worktreeDir(id, repo);
        // Best-effort like the mirrors: a checkout that refuses to narrow is reported and left whole rather than
        // failing the turn — the file-tool hook and the route fence still hold.
        await git(worktree, ["sparse-checkout", "set", "--cone", ...cone]).catch((error: unknown) =>
            logger.warn({ err: error, id, repo, cone }, "agents: could not narrow a fenced conversation's checkout"),
        );
    };

    const sparsenComposition = async (id: string, repos: readonly { readonly repo: string }[], fence: Fence): Promise<void> => {
        if (fence === undefined) {
            return;
        }
        await Promise.all(repos.map(({ repo }) => sparsen(id, repo, fence)));
    };

    // Commits what one checkout still holds onto its branch before the checkout goes (retire pass 1 / a leaving repo's
    // first half); no repo lock needed since this only touches the agent's own worktree.
    // The porcelain probe covers staged, unstaged and untracked, but the commit itself happens in
    // commitWorktreeRemainder, not here.
    const preserveOne = async (id: string, repo: string, title: string | undefined): Promise<void> => {
        const worktree = worktreeDir(id, repo);
        if (!(await pathExists(join(worktree, ".git")))) {
            return; // Never created, or already retired: nothing to preserve.
        }
        // Repository gone (repoBehind): no git command can run, so nothing to commit; caller still reclaims the dir.
        if (!(await repoBehind(worktree))) {
            logger.warn({ id, repo }, "agents: retiring a checkout whose repository is gone, nothing to preserve");
            return;
        }
        const { stdout } = await git(worktree, ["status", "--porcelain", "-z"]);
        if (stdout === "") {
            return;
        }
        await commitWorktreeRemainder(repo, worktree, `Agent: ${title ?? id}`, git);
    };

    // Drops one checkout and parks its branch (retire pass 2 / a leaving repo's second half); under the repo lock,
    // checkout removed before the ref parks since that's what makes it deletable.
    // Best-effort: a ref that fails to park just leaves a branch behind for the next boot sweep to pick up.
    const releaseOne = (id: string, repo: string): Promise<void> =>
        withRepoLock(repo, async () => {
            const main = mainDir(repo);
            await git(main, ["worktree", "remove", "--force", worktreeDir(id, repo)]).catch(() =>
                git(main, ["worktree", "prune"]).catch(() => undefined),
            );
            await parkAgentRefs(main, new Set([id]), git).catch((error: unknown) =>
                logger.warn({ err: error, repo, id }, "agents: branch park failed"),
            );
        });

    // A repo joining a conversation that already has its worktrees: unparking first means createOne finds the branch
    // and attaches instead of creating fresh.
    // A repo that was never here has no branch to unpark and gets a fresh one at main's head (or the pinned base a
    // snapshot supplied).
    const joinOne = async (id: string, repo: string, pinned: string | undefined): Promise<{ repo: string; base: string } | undefined> =>
        withRepoLock(repo, async () => {
            await unparkAgentRef(mainDir(repo), `agent/${id}`, git).catch((error: unknown) =>
                logger.warn({ err: error, repo }, "agents: branch unpark failed"),
            );
            return createOne(id, repo, pinned);
        });

    // Brings a recorded composition to `want`: repos it lacks join, ones it doesn't name leave; root is never a leaver.
    // Leaving is preserve then release so uncommitted edits land on agent/<id>; join and leave run concurrently.
    const reconcile = async (
        id: string,
        recorded: readonly { repo: string; base: string }[],
        want: readonly { repo: string; base: string | undefined }[],
    ): Promise<readonly { repo: string; base: string }[]> => {
        const have = new Map(recorded.map((entry) => [entry.repo, entry]));
        const wanted = new Set(want.map(({ repo }) => repo));
        const leaving = recorded.filter(({ repo }) => repo !== "root" && !wanted.has(repo));
        const joining = want.filter(({ repo }) => !have.has(repo));
        if (leaving.length === 0 && joining.length === 0) {
            return recorded;
        }
        const joined = new Map<string, { repo: string; base: string }>();
        await Promise.all([
            ...leaving.map(async ({ repo }) => {
                await preserveOne(id, repo, undefined);
                await releaseOne(id, repo);
                logger.info({ id, repo }, "agents: repo left the conversation's composition");
            }),
            ...joining.map(async ({ repo, base }) => {
                const made = await joinOne(id, repo, base);
                if (made !== undefined) {
                    joined.set(repo, made);
                    logger.info({ id, repo }, "agents: repo joined the conversation's composition");
                }
            }),
        ]);
        return want
            .map(({ repo }) => have.get(repo) ?? joined.get(repo))
            .filter((entry): entry is { repo: string; base: string } => entry !== undefined);
    };

    return {
        conversationDir,
        worktreeDir,
        mainDir,
        sessionStore: (entry) => claudeStoreOf(workspace.root, historyRoot, entry),
        exists: (id) => pathExists(conversationDir(id)),
        attached: async (id, repo) => (await checkedOutBranch(worktreeDir(id, repo))) === `agent/${id}`,
        elsewhere: elsewhereIn,
        snapshot: async () => {
            const repos = await liveRepos();
            const heads = await Promise.all(repos.map(async (repo) => ({ repo, base: await headSha(mainDir(repo)) })));
            return heads
                .filter((entry): entry is { repo: string; base: string } => entry.base !== undefined)
                .map(({ repo, base }) => ({ repo, base }));
        },
        ensure: async (id, recorded, base, namespaced, selection, fence) => {
            const branch = `agent/${id}`;
            // What the conversation should hold, root leading: every live repo, or the selected ones plus root, and
            // in either case only the ones the fence reaches.
            // Read live, not off the record, so a repo cloned since the last turn is seen whether or not the
            // conversation is selected.
            const wanted = async (): Promise<readonly { repo: string; base: string | undefined }[]> => {
                const live = base === undefined ? (await liveRepos()).map((repo) => ({ repo, base: undefined })) : base;
                const picked = selection === undefined ? live : live.filter(({ repo }) => repo === "root" || selection.includes(repo));
                const reachable = new Set(fencedComposition(fence, picked.map(({ repo }) => repo)));
                return picked.filter(({ repo }) => reachable.has(repo));
            };
            if (recorded.length > 0) {
                await eachRepo(recorded, "root-first", (repo) => withRepoLock(repo, () => repairOne(id, repo)));
                // An unselected, unfenced conversation keeps the composition it was born with; anything narrowed goes
                // to what it should now hold, so an edited area moves the checkout on the next turn.
                const repos = selection === undefined && fence === undefined ? recorded : await reconcile(id, recorded, await wanted());
                await sparsenComposition(id, repos, fence);
                await linkComposition(id, repos, namespaced);
                // Asked only on the repair path: a checkout this call just created stands on `branch` by construction.
                return { cwd: conversationDir(id), branch, repos, fenced: fence !== undefined, elsewhere: await elsewhereIn(id, repos) };
            }
            // Root first: its checkout creates the dir nested worktrees mount into (root excludes each repo dir).
            const live = await wanted();
            const created = new Map<string, { repo: string; base: string }>();
            await eachRepo(live, "root-first", async (repo) => {
                const pinned = live.find((entry) => entry.repo === repo)?.base;
                const made = await withRepoLock(repo, () => createOne(id, repo, pinned));
                if (made !== undefined) {
                    created.set(repo, made);
                }
            });
            // Read back in discovery order, not completion order: root leads the composition, recorded for later
            // repairs.
            const repos = live.map(({ repo }) => created.get(repo)).filter((entry): entry is { repo: string; base: string } => entry !== undefined);
            // Narrowed before the mirrors go in: `worktree add` checks the repository out whole, so the window where
            // a fenced conversation's folders exist on disk closes before its first turn can run.
            await sparsenComposition(id, repos, fence);
            await linkComposition(id, repos, namespaced);
            return { cwd: conversationDir(id), branch, repos, fenced: fence !== undefined, elsewhere: [] };
        },
        remove: async (id, recorded) => {
            await eachRepo(recorded, "root-last", (repo) =>
                withRepoLock(repo, async () => {
                    const main = mainDir(repo);
                    await git(main, ["worktree", "remove", "--force", worktreeDir(id, repo)]).catch(() =>
                        // Dir already gone, drop the stale admin entry instead.
                        git(main, ["worktree", "prune"]).catch(() => undefined),
                    );
                    // Both spellings: archived commits sit on the parked shelf; `branch -D` alone leaves them
                    // unreachable.
                    await dropAgentRef(main, `agent/${id}`, git);
                }),
            );
            await rm(conversationDir(id), { recursive: true, force: true });
            await rm(overlaysFor(id), { recursive: true, force: true });
        },
        retire: async (id, recorded, title) => {
            // Two passes: every repo commits before any checkout goes, so a failure partway through leaves worktrees
            // standing, not a branch missing their work.
            // Pass 1 takes no repo lock: it only touches this agent's own worktree (index, HEAD, its own ref), so
            // archiving one agent never serializes behind the fleet.
            await Promise.all(recorded.map(({ repo }) => preserveOne(id, repo, title)));
            // Pass 2 needs the repo lock (admin area), but only per repo, so nested repos release concurrently with
            // each other.
            // Root goes last: removing its dir first would delete nested checkouts out from under their own `worktree
            // remove`, forcing a wasted prune fallback.
            await eachRepo(recorded, "root-last", (repo) => releaseOne(id, repo));
            await rm(conversationDir(id), { recursive: true, force: true });
            // The branch is the archive; overlays aren't part of it and get dropped like a plain removal's.
            await rm(overlaysFor(id), { recursive: true, force: true });
        },
        reapRepoCheckout: async (id, repo) => {
            // Root is the workspace itself, never the vanished repo, so asking for it risks trashing the whole
            // checkout.
            const target = worktreeDir(id, repo);
            if (repo === "root" || !(await pathExists(target))) {
                return;
            }
            // Encoded like the git dirs beside it (history.ts reapGitDir): repo ids hold slashes; conversations stay
            // apart.
            const trashed = join(historyRoot, "trash", `${encodeURIComponent(repo)}-${id}-${Date.now()}`);
            try {
                await mkdir(dirname(trashed), { recursive: true });
                await rename(target, trashed);
                logger.warn({ id, repo, trashed }, "agents: reaped a deleted repo's checkout out of a conversation");
            } catch (error) {
                // The checkout stays where it is; warned rather than debugged since the next sweep retries it.
                logger.warn({ err: error, id, repo }, "agents: could not reap a deleted repo's checkout");
            }
        },
        prune: async (knownIds, archivedIds) => {
            for (const name of await readdir(worktreesRoot).catch(() => [])) {
                // Asked of the registry at the decision: a conversation minted after this sweep started isn't judged an
                // orphan.
                if (!knownIds().includes(name)) {
                    logger.warn({ id: name }, "agents: pruning orphaned worktree dir");
                    await rm(conversationDir(name), { recursive: true, force: true });
                }
            }
            // Swept separately: an overlay outlives its checkout by design (retire drops the worktree, keeps the
            // branch).
            // These are conversations gone entirely, including any a crash left behind between the two removals above.
            for (const name of await readdir(overlaysRoot(historyRoot)).catch(() => [])) {
                if (!knownIds().includes(name)) {
                    await rm(overlaysFor(name), { recursive: true, force: true });
                }
            }
            // A fenced conversation's own session store, swept on the same terms: it outlives the checkout too, and
            // holds the one copy of that conversation's transcripts.
            for (const name of await readdir(sessionsRoot(historyRoot)).catch(() => [])) {
                if (!knownIds().includes(name)) {
                    await rm(sessionsDir(historyRoot, name), { recursive: true, force: true });
                }
            }
            for (const repo of await liveRepos()) {
                // Under the repo lock since the sweep now runs concurrently with turns, touching what ensure/remove
                // touch too.
                await withRepoLock(repo, async () => {
                    const main = mainDir(repo);
                    await git(main, ["worktree", "prune"]).catch(() => undefined);
                    // The ref half of the sweep: converges an archive taken before parking existed, or one that lost
                    // its repo lock to a crash.
                    // Orphan parked refs drop against `knownIds`, not `archivedIds`: a ref the registry has forgotten
                    // holds commits nothing can reach again.
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
        repoBusy: (repo) => (queued.get(repo) ?? 0) > 0,
    };
};
