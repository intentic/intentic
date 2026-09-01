import { access, lstat, mkdir, readdir, readFile, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { commitWorktreeRemainder } from "../git/root-repo.js";
import type { PerfTracker } from "../platform/perf.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import type { WorkspacePaths } from "../workspace/workspace.js";
import { dropAgentRef, dropOrphanParkedRefs, parkAgentRefs, unparkAgentRef } from "./agent-refs.js";
import { mirroredDirs, overlaysDir, overlaysRoot, type TurnIsolation } from "./isolation.js";

// A conversation's isolated checkout: one git worktree per workspace repo, mirroring the /work layout,
// <worktreesRoot>/<id>/ is the ROOT repo's worktree and <worktreesRoot>/<id>/<repo>/ each nested
// repo's, so the agent, .claude/ config resolution, and monorepo-relative paths work unmodified. Worktrees
// live on /history (the volume the real git dirs already occupy): they survive container rebuilds, stay
// invisible to the /work tree walk + watcher + iq + history scopes, and their gitdir pointers never straddle
// volumes. The object stores are shared; a worktree costs only its checkout.
//
// The composition is FROZEN at first ensure: repos cloned into /work later don't join an existing
// conversation, and repos the agent clones inside its worktree are outside diff/land (both v2).

export interface ConversationWorktree {
    // The agent's cwd for isolated turns, the root repo's worktree dir.
    readonly cwd: string;
    readonly branch: string;
    // Each repo in the composition with the full sha its branch sits on the main line at. Set here at creation
    // and moved by the pre-turn rebase whenever the main line runs ahead of it (agents/sync.ts), so it is
    // where the branch stands TODAY, not a record of where it started.
    readonly repos: readonly { repo: string; base: string }[];
}

export interface AgentWorktrees {
    readonly conversationDir: (id: string) => string;
    readonly worktreeDir: (id: string, repo: string) => string;
    readonly mainDir: (repo: string) => string;
    readonly exists: (id: string) => Promise<boolean>;
    // Is this repo's checkout actually on disk? `archivedAt` cannot answer it: a restored agent keeps the
    // marker clear while its checkout stays retired until the next turn's ensure() re-attaches it. Diff,
    // fileDiff and land all branch on this, the checkout when it is there, the branch refs when it is not.
    readonly attached: (id: string, repo: string) => Promise<boolean>;
    // The current full HEAD of every repository a new conversation would span. A workflow captures this once
    // and hands it to every candidate, so a fan-out cannot observe several different moving workspaces.
    readonly snapshot: () => Promise<ConversationWorktree["repos"]>;
    // Create the composition on first use (recorded = []), optionally at a caller-owned immutable snapshot;
    // else repair what the recorded composition names.
    readonly ensure: (
        id: string,
        recorded: readonly { repo: string; base: string }[],
        base?: readonly { repo: string; base: string }[],
    ) => Promise<ConversationWorktree>;
    // Tear down: worktree remove (before the ref goes, git refuses to delete a checked-out branch), then the dir.
    readonly remove: (id: string, recorded: readonly { repo: string; base: string }[]) => Promise<void>;
    // Retire the CHECKOUT and keep the commits, what archiving an agent costs. Everything the worktree still
    // held is committed onto agent/<id> first (land's move, same author), so the branch is a complete record
    // and `ensure` can restore the checkout from it whenever the agent runs again. The branch itself then
    // leaves refs/heads/ for the parked shelf (agents/agent-refs.ts), which nothing above this layer can tell.
    readonly retire: (id: string, recorded: readonly { repo: string; base: string }[], title: string | undefined) => Promise<void>;
    /* Get a DELETED repo's checkout out of a conversation, the disk half of dropping it from the composition
     * (agents/vanished-repos.ts). Not a `worktree remove`: the repo it belonged to is gone, so there is no main
     * repo left to run one in and no admin entry left to prune, only a directory full of files.
     *
     * It has to GO, rather than simply be left unused, because of what it becomes the moment its repo stops
     * being discovered: the root repo's exclude list is re-derived from the LIVE repo set and shared by every
     * agent worktree (history.ts syncRootExcludes), so a checkout nothing excludes any more is untracked
     * content of the ROOT branch, sitting inside root's own worktree. The next `add -A` (a retire, a land's
     * remainder commit) would sweep a deleted repo's entire tree onto the agent's branch, and a land would
     * then put it back in /work as ordinary files.
     *
     * Moved to <historyRoot>/trash rather than deleted, the same treatment (and the same reasoning) as the git
     * dir that went with it: the daemon reclaiming a checkout is not the user deleting their work, and only
     * this copy of an uncommitted edit was ever going to exist. */
    readonly reapRepoCheckout: (id: string, repo: string) => Promise<void>;
    // Boot sweep: delete conversation dirs with no registry entry, `git worktree prune` every repo, park the
    // branches of agents that are off the board, and drop parked refs the registry no longer knows.
    //
    // The id sets are CALLBACKS, re-read at each decision, because this runs DETACHED behind the boot (it is
    // sweep work, and awaiting it held every route for minutes after a crash), a conversation the user opens
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

/* ROOT, THEN THE REST TOGETHER, the shape every pass over a composition takes, and the one thing about a
 * composition that is genuinely ordered.
 *
 * Root's checkout CREATES the conversation dir the nested worktrees mount into, so it cannot run beside them;
 * nothing else in a composition depends on anything else in it. `withRepoLock` is already per repo, so the
 * serial `for` loops this replaces were not protecting anything, each iteration simply waited on a lock it was
 * never going to contend, and a workspace that grew from one repo to six grew its turn-start cost by the same
 * factor, on the one path a person is watching. `retire` had always done it this way (see its pass 2); create,
 * repair and remove had not caught up.
 *
 * `direction` is which end root belongs at: building needs the parent dir first, tearing down needs it last, or
 * the nested `worktree remove`s find their checkouts already deleted and fall back to a prune. */
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

// DEPENDENCY MIRRORING. A worktree is a checkout of TRACKED files, and everything a package's imports resolve
// THROUGH is untracked by design, its installed tree and its build output (isolation.ts's MIRRORED_DIRS), so
// a fresh worktree holds source that cannot resolve a single import, its own siblings least of all. Nothing
// type-checks, lints or tests, and the post-edit diagnostics gate on a resolvable node_modules
// (agent-diagnostics.ts), so an isolated turn silently gets NO compile feedback at all while the readiness
// notice tells it, every turn, to run an install that would cost minutes and a duplicate tree per agent.
// Mirroring is the cheap answer: one symlink per dir, at the same relative path, pointing at the main
// checkout's. Node and TypeScript both resolve through symlinks by default, so tooling in a worktree behaves
// as it does in /work.
//
// The tradeoff this accepts, deliberately: the tree is SHARED, not copied. A worktree's `pnpm add` writes into
// the main checkout's node_modules (its package.json/lockfile edits stay in the worktree, where they belong),
// and a monorepo's workspace links resolve cross-package imports to /work's sources rather than the worktree's
// edited ones. Both beat the alternative, which is that nothing resolves at all.
//
// WHERE ISOLATION IS AVAILABLE, this is done with OVERLAY MOUNTS instead (agents/isolation.ts) and only the
// empty mount point is created here. That is strictly better and not just different: an absolute symlink into
// /work/... would, inside the namespace, point back into the worktree that now occupies /work, a loop. And
// unlike the symlink (or a plain bind), an overlay does not share the WRITE side: pnpm hardlinks a workspace
// package's sources into node_modules, so a write through the mirrored path used to land on the main
// checkout's own tracked file. Reads still come from the main tree; writes stop at the turn's layer.

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
     * checkout does not reclaim them, every teardown path below drops both. They hold only what a turn wrote
     * over the main tree's node_modules (a tsbuildinfo, an install's output), so this is space, never work:
     * nothing an agent is meant to keep is ever written there. */
    const overlaysFor = (id: string): string => overlaysDir(historyRoot, id);
    const worktreeDir = (id: string, repo: string): string => (repo === "root" ? conversationDir(id) : join(conversationDir(id), repo));
    const mainDir = (repo: string): string => (repo === "root" ? workspace.root : join(workspace.root, repo));

    /* IS THERE STILL A REPOSITORY BEHIND THIS CHECKOUT? Asked before anything tries to PRESERVE what the
     * checkout holds (retire's pass 1), because a worktree whose repository has gone cannot answer a single git
     * command: its `.git` file is a pointer into `<main>/.git/worktrees/<name>`, and a repo the user deleted,
     * re-cloned or renamed in /work takes that directory with it. Every command in the worktree then dies with
     * "fatal: not a git repository", which is not a transient failure but a permanent one.
     *
     * That is exactly what stranded conversations on the board: archiving threw on the status probe, the daemon
     * dropped the agent from the batch, and the card came back with nothing anyone could do about it, forever.
     * There is nothing to preserve in this case and no way to preserve it, so the honest answer is to skip the
     * commit and reclaim the directory, which is all archiving ever promised for a checkout. */
    const repoBehind = async (worktree: string): Promise<boolean> => {
        const pointer = join(worktree, ".git");
        // A real .git DIRECTORY is a repository of its own (never a worktree pointer), so it needs no resolving.
        const stats = await lstat(pointer).catch(() => undefined);
        if (stats === undefined) {
            return false;
        }
        if (stats.isDirectory()) {
            return true;
        }
        const gitdir = (await readFile(pointer, "utf8").catch(() => ``)).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
        return gitdir !== undefined && (await exists(gitdir));
    };

    // Per-repo op chains (the history.ts serialize pattern): worktree add/remove and land all touch the repo's
    // shared admin area (<gitdir>/worktrees/) and, for land, the main-tree index. Turns themselves never come
    // through here, per-worktree index/HEAD make concurrent agent work naturally safe.
    const chains = new Map<string, Promise<unknown>>();
    // How many tasks are queued on each repo's chain right now, measurement only, and the single number that
    // separates the two ways this lock makes a user wait (see below).
    const queued = new Map<string, number>();
    /* WAIT AND HOLD ARE MEASURED SEPARATELY, because they are different problems wearing the same symptom.
     *
     * The user clicks Stage; it takes four seconds. Either the stage itself was slow (hold, a huge index, a
     * contended disk), or it sat behind an agent's land checking out the monorepo (wait, the stage was
     * instant and never got to start). Those have nothing in common: one is a git problem, the other is a
     * scheduling one, and a single "the commit took 4s" line cannot tell you which you have. This is the
     * likeliest explanation for "git actions feel slow" and it was completely invisible, a queued task simply
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
    // skipped in createOne, an unborn HEAD has nothing to branch from.
    const liveRepos = async (): Promise<string[]> => ["root", ...(await discoverRepos(workspace.root))];

    /* WHY AN AGENT WORKTREE NEVER CHECKS OUT THE STATE DIR, and what it cost to find out.
     *
     * `.intentic` is workspace state that every namespace SHARES: isolation.ts binds the main tree's copy over
     * the worktree's own, so a draft the agent writes and a transcript the daemon appends are one file and not
     * two. Part of it is also VERSIONED — the owner's settings, personas, workflows, the environment overlay,
     * an extension they wrote (history.ts trackedStateExcludes, off the contract's `versioned` allowlist),
     * because a change to how this sandbox behaves belongs in review and in `git log`.
     *
     * Those two facts collide, and the collision eats work. Every worktree's git believes it owns the files at
     * that path, and behind the path there is exactly ONE directory: a checkout, a rebase or a reset in ANY
     * conversation writes that branch's committed copy straight through the bind mount and over what the
     * workspace is actually running, and the next `add -A` commits the stale copy back. That is not
     * hypothetical. One conversation shipped a workspace extension at 21:58; a second, still based on the
     * commit before it, was rebased an hour later, its checkout put the old file back, and its land committed
     * the revert — 949 lines removed, under a subject about something else entirely, authored by nobody who
     * meant it.
     *
     * So the state dir is kept out of the checkout altogether. SPARSE-CHECKOUT rather than a plain
     * skip-worktree bit because git's own checkout machinery understands it: the index still carries the
     * versioned entries and a rebase moves them forward exactly as it does any other path, nothing is ever
     * written to disk for them, and `git status` in the worktree cannot see the shared tree at all. The mount
     * point the bind needs is recreated by the isolation script's own `mkdir -p`, so removing the directory
     * here costs the mount nothing.
     *
     * Root repo only: the state dir is the ROOT repo's content, and a nested repo's worktree has none.
     *
     * Converged rather than set once, because every worktree that predates this ran without it. THE GUARD
     * READS THE PATTERN FILE, NOT `core.sparseCheckout`, and that distinction is the whole of a second
     * incident: `info/sparse-checkout` is per-worktree, but config is SHARED by every worktree of a repo
     * unless `extensions.worktreeConfig` is on, and it is not. Keying convergence off the flag let the first
     * worktree to converge answer for all of them — every worktree created afterwards read `true`, returned
     * here, and never wrote a pattern of its own. Sparse checkout nominally on, no pattern, nothing excluded,
     * seventeen of eighteen worktrees with the state dir fully live in `git status`; an agent's in-flight edit
     * to a workspace extension was swept into a different conversation's land, on main, under a subject about
     * something else. Reading the file costs the same single spawn and cannot be answered by a sibling.
     *
     * THE PATTERN ALONE IS NOT ENOUGH, and the third incident is the mirror image of the first. Inside the
     * agent's namespace the excluded path is NOT empty: the bind puts main's live state dir there, so every
     * versioned entry git believes it left out of the checkout is, as far as git can see, present. Git treats a
     * present-but-skipped file as the user having put it back, and a plain `git status` clears its
     * skip-worktree bit. From then on the entry is an ordinary tracked file that the pattern says should NOT be
     * on disk, and the next tree reset — `reset --hard`, `stash`, `rebase --autostash`, `rebase --abort`, all
     * of them ordinary moves for an agent told to rebase — re-applies the pattern by UNLINKING it. Through the
     * bind, that unlink lands on main's file: fourteen config files gone from the workspace, deleted by no land
     * and so attributed to nobody, which the Changes panel renders as the user's own doing. A rebase that
     * brings a NEW versioned entry down from main takes the same road without the status step: git leaves it
     * checked-in-but-present ("left despite sparse patterns") and the reset that follows removes it.
     *
     * `sparse.expectFilesOutsideOfPatterns` is git's own switch for exactly this shape: files outside the
     * patterns are expected to be present, so the bit is never cleared, a new entry arrives skipped, and no
     * reset has anything to remove. The flag is repo config, shared like `core.sparseCheckout`, and set beside
     * it. The marker line in the pattern file is what carries the change to worktrees that converged before
     * it existed: the guard compares the whole text, so a pattern from before the flag is re-converged once,
     * and the `read-tree -mu HEAD` that follows (run outside the namespace, where the path really is empty)
     * puts the bit back on any entry a status inside the namespace has already stripped.
     */
    const excludeSharedState = async (dir: string): Promise<void> => {
        // Everything at the root, then the one exclusion. `--no-cone` spelling: cone mode takes directories to
        // KEEP and cannot express "all of it except this". The comment line is the convergence marker (see
        // the header): bump it whenever what this function writes beside the pattern changes.
        const pattern = `# intentic: shared state dir, present through the bind\n/*\n!/${STATE_DIR}/\n`;
        const printed = (await git(dir, ["rev-parse", "--git-path", "info/sparse-checkout"])).stdout.trim();
        const target = isAbsolute(printed) ? printed : join(dir, printed);
        if ((await readFile(target, "utf8").catch(() => undefined)) === pattern) {
            return;
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, pattern);
        try {
            await git(dir, ["config", "core.sparseCheckout", "true"]);
            // The bind makes every skipped entry look present from inside the namespace; this tells git that
            // is expected, so it neither un-skips them on a status nor unlinks them on a reset (see header).
            await git(dir, ["config", "sparse.expectFilesOutsideOfPatterns", "true"]);
            // Applies the pattern to the checkout that is already on disk: the state dir's files leave the
            // worktree and their index entries take git's skip-worktree bit. Outside the namespace, so a
            // re-converge over an entry a status inside it has un-skipped finds nothing on disk to remove.
            await git(dir, ["read-tree", "-mu", "HEAD"]);
        } catch (error) {
            /* The pattern file is now the convergence marker, so a half-applied state must not leave one
             * behind: every later turn would read it, believe this worktree converged, and skip the retry
             * forever. Take it back out and let the next turn start clean — the same property the old ordering
             * got from writing the config flag last. */
            await rm(target, { force: true });
            throw error;
        }
    };

    const createOne = async (id: string, repo: string, pinned?: string): Promise<{ repo: string; base: string } | undefined> => {
        const main = mainDir(repo);
        const base = pinned ?? (await headSha(main));
        if (base === undefined) {
            logger.warn({ repo }, "agents: unborn HEAD, repo excluded from worktree composition");
            return undefined;
        }
        const branch = `agent/${id}`;
        const target = worktreeDir(id, repo);
        // A crash between branch creation and checkout leaves the branch without a dir, attach, don't recreate.
        if (await branchExists(main, branch)) {
            await git(main, ["worktree", "add", target, branch]);
        } else {
            await git(main, ["worktree", "add", "-b", branch, target, base]);
        }
        if (repo === "root") {
            await excludeSharedState(target);
        }
        return { repo, base };
    };

    const repairOne = async (id: string, repo: string): Promise<void> => {
        const target = worktreeDir(id, repo);
        if (await exists(join(target, ".git"))) {
            // Ahead of the early return: a healthy worktree is exactly the one that still needs converging, and
            // this is the only line every turn of every existing conversation passes through.
            if (repo === "root") {
                await excludeSharedState(target).catch((error: unknown) => logger.warn({ err: error, repo }, "agents: state-dir exclusion failed"));
            }
            return;
        }
        /* Past the early return is the RESTORE path, so the branch may be parked, an archived agent the user
         * just sent a message to (registry.begin cleared the marker moments ago), or one this boot's sweep
         * archived for having no checkout. Unparking is a no-op for anything else, and it has to come first:
         * `worktree add` handed a name that resolves only through the shelf checks the commit out DETACHED,
         * and the resumed turn's commits would then land on nothing. One spawn, on the path that already
         * spends several, never on the attached path above, which is every ordinary turn. */
        await unparkAgentRef(mainDir(repo), `agent/${id}`, git).catch((error: unknown) =>
            logger.warn({ err: error, repo }, "agents: branch unpark failed"),
        );
        // The worktree analogue of history's healGitPointer: repair rewrites the worktree's .git file and the
        // admin dir's gitdir backlink. A fully deleted worktree dir is re-attached from its surviving branch.
        if (await exists(target)) {
            await git(mainDir(repo), ["worktree", "repair", target]).catch((error: unknown) =>
                logger.warn({ err: error, repo }, "agents: worktree repair failed"),
            );
        } else {
            await git(mainDir(repo), ["worktree", "add", target, `agent/${id}`]).catch((error: unknown) =>
                logger.warn({ err: error, repo }, "agents: worktree re-attach failed"),
            );
        }
        // A restored checkout is a fresh one as far as the state dir goes: `worktree add` writes the whole tree.
        if (repo === "root") {
            await excludeSharedState(target).catch((error: unknown) => logger.warn({ err: error, repo }, "agents: state-dir exclusion failed"));
        }
    };

    // Which of these link paths git will keep out of a commit, asked of git rather than assumed, because the
    // answer is not the obvious one. `retire` sweeps a worktree with `add -A`, and a gitignore rule written
    // DIRECTORY-ONLY (`node_modules/`, the common form) does not match a symlink: git sees a file, stages it,
    // and a machine-local absolute symlink lands on the agent branch and then in whatever `land` merges. Only a
    // rule that matches files too (`**/node_modules`) makes the link safe to plant. So a repo whose rule is
    // directory-only is left unmirrored on purpose, no tooling, but no poisoned history either.
    //
    // One spawn per repo answers it exactly. check-ignore exits 1 when nothing matches, which is the "link
    // nothing" answer rather than a failure; `-z` is unavailable (it requires --stdin, which GitRunner cannot
    // feed), so this reads line-separated output and any path git chose to quote simply fails to match, the
    // same fail-closed direction as the exit-1 case.
    const ignoredLinks = async (worktree: string, links: readonly string[]): Promise<Set<string>> => {
        if (links.length === 0) {
            return new Set();
        }
        const { stdout } = await git(worktree, ["check-ignore", ...links]).catch(() => ({ stdout: "" }));
        return new Set(stdout.split("\n").filter((path) => path !== ""));
    };

    // Mirror one repo's untracked dependency and build-output dirs from its main checkout into its worktree.
    // Idempotent, an existing link, and a package the agent's branch doesn't carry, are both left alone, so
    // it re-runs on every ensure and picks up dirs an install or build produced after the checkout did.
    // Best-effort by design: a link that fails costs that package's tooling, never the turn.
    const linkMirrors = async (id: string, repo: string): Promise<void> => {
        const main = mainDir(repo);
        const worktree = worktreeDir(id, repo);
        const mirrors = await mirroredDirs(main, worktree, { intoNestedRepos: false });
        const ignored = await ignoredLinks(worktree, mirrors);
        // An isolated turn gets these as overlay mounts inside its namespace, so all this has to leave behind
        // is something to mount ONTO. The gitignore check still gates it: an empty dir git would commit is
        // just as unwelcome on the branch as a machine-local symlink.
        const isolated = await isolation.available();
        await Promise.all(
            mirrors.map(async (rel) => {
                const target = join(worktree, rel);
                // The dir the mirror belongs to, a package the agent's branch does not carry gets nothing.
                if (!ignored.has(rel) || !(await exists(join(worktree, dirname(rel))))) {
                    return;
                }
                // The mirror's FORM is a property of the container (namespace or not), and worktrees outlive
                // containers on /history, so a checkout can carry the other mode's form, and ensure must
                // converge it. A pre-namespace absolute symlink would, inside the namespace, resolve back into
                // the worktree that now occupies /work, a loop the anchor's mkdir dies on. The other way, an
                // empty mount point left by an isolated run would sit where the symlink belongs and resolve
                // nothing for a namespace-less turn.
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
                    // rmdir refuses a non-empty dir, a real install the agent made stays put.
                    await rmdir(target).catch(() => undefined);
                }
                // "junction" on Windows: a dir symlink there needs a privilege ordinary accounts lack, while a
                // junction does the same resolve-through job unprivileged (and takes the absolute path this is).
                await symlink(join(main, rel), target, process.platform === "win32" ? "junction" : "dir").catch((error: unknown) => {
                    // EEXIST is the steady state, not a failure: the link, or a real install, is already there.
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                        logger.warn({ err: error, repo, mirror: rel }, "agents: mirror link failed");
                    }
                });
            }),
        );
    };

    // Runs once the WHOLE composition is on disk: a nested repo's worktree dir must exist before links can be
    // planted in it. No repo lock, this reads the main checkout and writes only inside this conversation's own
    // worktree, so taking one would serialize the fleet behind a queue it has no reason to join.
    const linkComposition = async (id: string, repos: readonly { readonly repo: string }[]): Promise<void> => {
        await Promise.all(repos.map(({ repo }) => linkMirrors(id, repo)));
    };

    return {
        conversationDir,
        worktreeDir,
        mainDir,
        exists: (id) => exists(conversationDir(id)),
        attached: (id, repo) => exists(join(worktreeDir(id, repo), ".git")),
        snapshot: async () => {
            const repos = await liveRepos();
            const heads = await Promise.all(repos.map(async (repo) => ({ repo, base: await headSha(mainDir(repo)) })));
            return heads
                .filter((entry): entry is { repo: string; base: string } => entry.base !== undefined)
                .map(({ repo, base }) => ({ repo, base }));
        },
        ensure: async (id, recorded, base) => {
            const branch = `agent/${id}`;
            if (recorded.length > 0) {
                await eachRepo(recorded, "root-first", (repo) => withRepoLock(repo, () => repairOne(id, repo)));
                await linkComposition(id, recorded);
                return { cwd: conversationDir(id), branch, repos: recorded };
            }
            // Root first: its checkout creates the conversation dir the nested worktrees mount into (the root
            // repo excludes every repo dir, syncRootExcludes, so the mounts never collide with its own
            // tracked files).
            const live = base === undefined ? (await liveRepos()).map((repo) => ({ repo, base: undefined })) : base;
            const created = new Map<string, { repo: string; base: string }>();
            await eachRepo(live, "root-first", async (repo) => {
                const pinned = live.find((entry) => entry.repo === repo)?.base;
                const made = await withRepoLock(repo, () => createOne(id, repo, pinned));
                if (made !== undefined) {
                    created.set(repo, made);
                }
            });
            // Read back in DISCOVERY order rather than in the order the creations happened to finish: root leads
            // a composition (the worktree frame takes its base from that, and the record is written down for
            // every later turn to repair against), and completion order is whatever the disk felt like.
            const repos = live.map(({ repo }) => created.get(repo)).filter((entry): entry is { repo: string; base: string } => entry !== undefined);
            await linkComposition(id, repos);
            return { cwd: conversationDir(id), branch, repos };
        },
        remove: async (id, recorded) => {
            await eachRepo(recorded, "root-last", (repo) =>
                withRepoLock(repo, async () => {
                    const main = mainDir(repo);
                    await git(main, ["worktree", "remove", "--force", worktreeDir(id, repo)]).catch(() =>
                        // Dir already gone, drop the stale admin entry instead.
                        git(main, ["worktree", "prune"]).catch(() => undefined),
                    );
                    // Both spellings: an archived agent being discarded holds its commits on the parked shelf,
                    // and `branch -D` alone would leave them behind with nothing left to reach them by.
                    await dropAgentRef(main, `agent/${id}`, git);
                }),
            );
            await rm(conversationDir(id), { recursive: true, force: true });
            await rm(overlaysFor(id), { recursive: true, force: true });
        },
        retire: async (id, recorded, title) => {
            // Two passes on purpose. EVERY repo is committed before ANY checkout goes, so a failure partway
            // through leaves worktrees standing rather than a branch that is missing the work its checkout held.
            //
            // PASS 1 takes NO repo lock, and that is the difference between archiving one agent and archiving
            // ten: `withRepoLock` is a per-repo chain shared by every agent, so holding it here would serialize
            // the whole fleet's preserve work behind one queue. Nothing in this pass needs it, the status read,
            // the index write and the commit all happen inside THIS agent's own worktree (its own index, its own
            // HEAD), and the only shared things it touches are the object store (content-addressed) and its own
            // refs/heads/agent/<id> (git's per-ref lockfile). The admin area `withRepoLock` exists to protect is
            // touched only by pass 2.
            await Promise.all(
                recorded.map(async ({ repo }) => {
                    const worktree = worktreeDir(id, repo);
                    if (!(await exists(join(worktree, ".git")))) {
                        return; // Never created, or already retired: nothing to preserve.
                    }
                    // The repository this checkout belongs to is gone (see repoBehind): no git command can run
                    // here, so there is nothing to commit and no way to commit it. Pass 2 still reclaims the dir,
                    // and agents/vanished-repos.ts takes the repo out of the composition for good.
                    if (!(await repoBehind(worktree))) {
                        logger.warn({ id, repo }, "agents: retiring a checkout whose repository is gone, nothing to preserve");
                        return;
                    }
                    // ONE spawn to answer "is there anything to keep", which is the answer in the common case:
                    // a cleanly-landed agent's worktree is already clean, because land committed its remainder.
                    // (The full changedFiles read this replaced cost five to seven spawns to say the same thing,
                    // per repo, per agent, the single biggest chunk of an archive's wall clock.) Porcelain
                    // covers staged, unstaged AND untracked, which is exactly what `add -A` below would sweep.
                    // It also OVER-reports, dirty content inside a nested repo stages as nothing, which is
                    // why the commit itself is commitWorktreeRemainder's call, on the index, and not this probe's.
                    const { stdout } = await git(worktree, ["status", "--porcelain", "-z"]);
                    if (stdout === "") {
                        return;
                    }
                    await commitWorktreeRemainder(repo, worktree, `Agent: ${title ?? id}`, git);
                }),
            );
            // PASS 2 does need the lock (worktree admin area), but only per repo, so the nested repos run
            // concurrently with each other. ROOT GOES LAST: its worktree dir is the parent the nested checkouts
            // mount into, so removing it first deletes them out from under their own `worktree remove`, which
            // then fails into a `prune` fallback, two wasted spawns per nested repo, every time.
            const removeOne = (repo: string): Promise<void> =>
                withRepoLock(repo, async () => {
                    const main = mainDir(repo);
                    await git(main, ["worktree", "remove", "--force", worktreeDir(id, repo)]).catch(() =>
                        git(main, ["worktree", "prune"]).catch(() => undefined),
                    );
                    /* The commits stay, they ARE the archive, but the BRANCH does not: it moves to the
                     * parked shelf (agent-refs.ts), so an archive costs the repo no refs/heads/ entry for as
                     * long as nobody opens the conversation again. Inside the repo lock and strictly after
                     * the checkout is gone, because that is the one thing that makes the ref deletable.
                     * Best-effort: an agent whose ref will not park is an agent that archived fine and left a
                     * branch behind, which the next boot's sweep picks up. */
                    await parkAgentRefs(main, new Set([id]), git).catch((error: unknown) =>
                        logger.warn({ err: error, repo, id }, "agents: branch park failed"),
                    );
                });
            await eachRepo(recorded, "root-last", removeOne);
            await rm(conversationDir(id), { recursive: true, force: true });
            // The branch is the archive; the overlays are not part of it, an archived conversation's
            // dependency scratch has no more claim on the disk than a removed one's.
            await rm(overlaysFor(id), { recursive: true, force: true });
        },
        reapRepoCheckout: async (id, repo) => {
            // Root is the workspace itself and cannot be the repo that vanished; asking for it would move a
            // whole conversation's checkout to the trash on the strength of a momentarily unreadable /work.
            const target = worktreeDir(id, repo);
            if (repo === "root" || !(await exists(target))) {
                return;
            }
            // Encoded like the git dirs beside it (history.ts reapGitDir): a nested repo id holds slashes, and
            // one entry per conversation keeps two agents' checkouts of the same dead repo apart.
            const trashed = join(historyRoot, "trash", `${encodeURIComponent(repo)}-${id}-${Date.now()}`);
            try {
                await mkdir(dirname(trashed), { recursive: true });
                await rename(target, trashed);
                logger.warn({ id, repo, trashed }, "agents: reaped a deleted repo's checkout out of a conversation");
            } catch (error) {
                // The checkout stays where it is, which is the pollution risk in the header, so this is a
                // warning rather than a debug line: the next sweep retries it.
                logger.warn({ err: error, id, repo }, "agents: could not reap a deleted repo's checkout");
            }
        },
        prune: async (knownIds, archivedIds) => {
            for (const name of await readdir(worktreesRoot).catch(() => [])) {
                // Membership is asked of the registry AT the decision, a conversation minted after this sweep
                // started (the sweep runs detached behind boot) must not have its dir swept as an orphan.
                if (!knownIds().includes(name)) {
                    logger.warn({ id: name }, "agents: pruning orphaned worktree dir");
                    await rm(conversationDir(name), { recursive: true, force: true });
                }
            }
            // Swept separately, not alongside the checkouts: an overlay outlives its checkout by design (retire
            // drops the worktree and keeps the branch), so the leftovers here are the ones whose conversation
            // is gone entirely, including any a crash left behind between the two removals above.
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
                     * parking existed, or one whose park lost its repo lock to a crash. Both calls are a single
                     * for-each-ref when there is nothing to do, which is every boot after the first.
                     *
                     * Orphan parked refs are dropped against `knownIds`, NOT `archivedIds`: a ref whose entry the
                     * registry has forgotten is holding commits no surface can ever reach again. That is the same
                     * line the conversation-dir sweep above draws, and it stays on the safe side of it, deletion
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
