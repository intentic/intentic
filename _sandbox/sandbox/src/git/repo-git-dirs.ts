import { cp, lstat, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { repoGitDir } from "../history/history.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import type { WorkspacePaths } from "../workspace/workspace.js";

/* NO GIT DIR LIVES UNDER /work, the invariant that lets an isolated turn's worktree stand in for the
 * workspace root (agents/isolation.ts).
 *
 * A worktree's `.git` is a POINTER holding the absolute path of its admin dir inside the main repo's git dir.
 * While that git dir sits at /work/<repo>/.git, the pointer reads
 * `/work/<repo>/.git/worktrees/<id>`, and inside a namespace where /work IS the worktree, that path resolves
 * to the worktree's own pointer file. Git then answers "not a git repository" for every command the agent
 * runs: no status, no diff, no commit, and `land` has nothing to preserve.
 *
 * Moving the real git dir onto /history takes it out of the shadowed subtree entirely, so the SAME pointer
 * resolves identically inside and outside the namespace. Every repo the daemon creates already has this shape
 * (`--separate-git-dir`, history.ts repoGitDir); this converges the ones that arrived any other way, an agent's
 * own `git clone`, a repo restored from a backup, the workspace this daemon was developed in.
 *
 * Convergence, not a one-shot: it re-runs every boot, like ensureRootRepo's pointer rewrite and history's
 * healGitPointer, and does nothing at all once a repo is already in the target shape (the steady state).
 */

// Which shape is this repo's `.git` in? A pointer FILE is the target shape; a real DIR has to move. Anything
// else (missing, a dangling symlink) is not a repo this step can act on.
const gitEntryKind = async (repoDir: string): Promise<"dir" | "file" | undefined> => {
    const stats = await lstat(join(repoDir, ".git")).catch(() => undefined);
    if (stats === undefined) {
        return undefined;
    }
    return stats.isDirectory() ? "dir" : "file";
};

/* NO REPO PINS ITS OWN WORKING TREE, the second half of the same invariant.
 *
 * `core.worktree` records an ABSOLUTE path in the repo's config, and the config lives in the git dir that
 * every worktree of the repo shares. Set to `/work/<repo>` it names a different directory in every mount
 * namespace: the main checkout for the daemon, and the turn's OWN worktree for an isolated turn. So a turn
 * that deliberately reached for the main tree at MAIN_MOUNT, the one path isolation.ts provides for exactly
 * that, got git silently redirected back to its own worktree, compared against the MAIN checkout's index,
 * and answered with a diff belonging to neither. That is the "compare against main" case the aside mount
 * exists to serve, reporting confident nonsense.
 *
 * Nothing needs the pin. A `.git` FILE makes the worktree implicit: git discovers upward, finds the pointer,
 * and takes the directory CONTAINING it as the working tree, which is the right answer in every namespace
 * precisely because it is resolved relative to where the caller stands rather than written down once. (This
 * is also what `git init --separate-git-dir` produces; it sets no core.worktree either.) The one caller that
 * enters by git dir alone passes GIT_WORK_TREE explicitly (history.ts deletionState), so it never depended on
 * the config value.
 *
 * Unset rather than merely not-set: convergence re-runs every boot, and a repo carrying the pin from an
 * earlier one is exactly the repo this has to fix.
 */
const unpinWorktree = async (repoDir: string, git: GitRunner): Promise<void> => {
    // Exits non-zero when the key was already absent, the steady state, not a failure.
    await git(repoDir, ["config", "--unset", "core.worktree"]).catch(() => undefined);
};

/* NO REPO WITH A CHECKOUT CALLS ITSELF BARE, the third part of the same invariant — and the one that fails
 * loudly rather than subtly.
 *
 * `core.bare` lives in the shared config too, so it is a fact about the GIT DIR rather than about any one
 * worktree. A git dir that arrived from a `--bare` clone, or one whose checkout was hung off it with `git
 * worktree add` afterwards, carries `true`; the pointer at `/work/<repo>/.git` then names a repository git
 * refuses to work in. `git -C /work/<repo> status` answers `fatal: this operation must be run in a work tree`,
 * and the Changes panel draws the repo as one it could not read with git's own sentence under it — while the
 * files are sitting right there.
 *
 * LINKED worktrees are unaffected, which is what makes it easy to miss for a long time: they enter through
 * their own admin dir under `worktrees/`, where the flag does not apply. So every agent conversation reads its
 * repo perfectly and the owner's MAIN tree — the only one anybody reviews changes in — reports nothing at all.
 *
 * Every repo this step visits was discovered BY its directory under /work, so a checkout provably exists for it
 * and `false` is the only value that can be right. Read before writing, so the steady state (which is every
 * repo, nearly every boot) touches no config file and takes no lock. */
const unbare = async (repoDir: string, git: GitRunner): Promise<void> => {
    // Exits non-zero when the key is absent, which is itself the target shape: git's default is false.
    const current = await git(repoDir, ["config", "--get", "core.bare"]).catch(() => undefined);
    if (current?.stdout.trim() !== "true") {
        return;
    }
    await git(repoDir, ["config", "core.bare", "false"]);
};

const relocateOne = async (repo: string, workspace: WorkspacePaths, historyRoot: string, logger: Logger, git: GitRunner): Promise<void> => {
    const repoDir = join(workspace.root, repo);
    if ((await gitEntryKind(repoDir)) !== "dir") {
        return;
    }
    const target = repoGitDir(historyRoot, repo);
    if ((await lstat(target).catch(() => undefined)) !== undefined) {
        // A git dir is already parked there for this id, moving onto it would destroy whichever one is real.
        // The repo keeps working exactly as it does today; only namespace isolation is unavailable for it.
        logger.warn({ repo, target }, "git dirs: target already occupied, repo left with an in-tree git dir");
        return;
    }
    /* COPY-then-swap, not rename: /work and /history are separate mounts, so `rename` fails EXDEV even when
     * they sit on one device. The copy is what makes the step interruptible, a crash before the pointer is
     * written leaves the original .git untouched and authoritative, and the next boot simply finds the target
     * occupied. `dereference: false` keeps git's own symlinks intact. */
    const entry = join(repoDir, ".git");
    await cp(entry, target, { recursive: true, dereference: false });
    // The directory has to go before the pointer can take its name. From here to the writeFile the repo has no
    // git entry at all, so a failure restores the copy under the original name rather than leaving it headless.
    await rm(entry, { recursive: true, force: true });
    await writeFile(entry, `gitdir: ${target}\n`).catch(async (error: unknown) => {
        await cp(target, entry, { recursive: true, dereference: false });
        await rm(target, { recursive: true, force: true });
        throw error;
    });
    /* Every worktree of this repo holds a pointer into the OLD admin path, and the admin dirs hold a backlink
     * to each worktree. `worktree repair`, run from the main checkout, rewrites both sides for all of them,
     * the same call worktrees.ts::repairOne makes for a single conversation. Without it, every existing agent
     * conversation loses its checkout the moment the git dir moves. */
    await git(repoDir, ["worktree", "repair"]).catch((error: unknown) => logger.warn({ err: error, repo }, "git dirs: worktree repair failed"));
    logger.info({ repo, target }, "git dirs: relocated in-tree git dir off the workspace root");
};

// Converge every workspace repo onto an out-of-tree git dir that names no worktree of its own and does not call
// itself bare. Best-effort per repo: one repo that cannot move must not stop the others, and must not stop the
// boot, it only loses isolation for itself. The two config repairs run for EVERY repo, not only the ones that
// move: a repo converged by an earlier boot is already in the pointer shape and would otherwise keep a stale
// pin — or an unusable main checkout — forever.
export const ensureRepoGitDirs = async (
    workspace: WorkspacePaths,
    historyRoot: string,
    logger: Logger,
    git: GitRunner = defaultGit,
): Promise<void> => {
    for (const repo of await discoverRepos(workspace.root)) {
        await relocateOne(repo, workspace, historyRoot, logger, git).catch((error: unknown) =>
            logger.warn({ err: error, repo }, "git dirs: relocation failed, repo keeps its in-tree git dir"),
        );
        await unpinWorktree(join(workspace.root, repo), git);
        await unbare(join(workspace.root, repo), git).catch((error: unknown) =>
            logger.warn({ err: error, repo }, "git dirs: could not clear core.bare, the main checkout stays unreadable to git"),
        );
    }
};
